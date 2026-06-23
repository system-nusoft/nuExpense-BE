import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { AiService } from '../ai/ai.service';
import { CurrencyService } from '../currency/currency.service';
import { normalizeVendor, vendorSimilarity } from './utils/vendor.utils';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { v4 as uuidv4 } from 'uuid';

interface ExpenseQueryParams {
  page?: number;
  limit?: number;
  categoryId?: string;
  startDate?: string;
  endDate?: string;
}

export interface MonthlySummaryRow {
  month: string;
  total: number;
  count: number;
}

export interface CategorySummaryItem {
  categoryId: string | null;
  name: string;
  color: string;
  icon: string | null;
  total: number;
  budgetAmount: number | null;
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
    private readonly aiService: AiService,
    private readonly currencyService: CurrencyService,
  ) {}

  async scan(userId: string, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No receipt file provided');
    }

    const ext = this.getExtension(file.mimetype);
    const key = `receipts/${userId}/${uuidv4()}.${ext}`;

    // Upload to S3
    await this.s3Service.uploadBuffer(key, file.buffer, file.mimetype);

    // Convert buffer to base64
    const imageBase64 = file.buffer.toString('base64');

    // Fetch user categories for AI context
    const categories = await this.prisma.category.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    });

    // Analyze receipt
    const analysis = await this.aiService.analyzeReceipt(
      imageBase64,
      file.mimetype,
      categories,
    );

    return {
      ...analysis,
      receiptImageKey: key,
    };
  }

  async create(userId: string, dto: CreateExpenseDto) {
    if (dto.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, userId },
      });
      if (!cat) {
        throw new NotFoundException('Category not found');
      }
    }

    let receiptImageUrl: string | null = null;
    if (dto.receiptImageKey) {
      receiptImageUrl = await this.s3Service.generatePresignedGetUrl(
        dto.receiptImageKey,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { homeCurrency: true },
    });
    const homeCurrency = user?.homeCurrency ?? 'USD';
    const expenseCurrency = dto.currency ?? 'USD';
    const rate = await this.currencyService.getRate(expenseCurrency, homeCurrency);
    const homeCurrencyAmount = parseFloat(dto.amount.toString()) * rate;

    return this.prisma.expense.create({
      data: {
        userId,
        vendor: dto.vendor,
        amount: dto.amount,
        currency: expenseCurrency,
        date: new Date(dto.date),
        categoryId: dto.categoryId ?? null,
        receiptImageKey: dto.receiptImageKey ?? null,
        receiptImageUrl,
        notes: dto.notes ?? null,
        homeCurrencyAmount,
        homeCurrencyCode: homeCurrency,
      },
      include: {
        category: true,
      },
    });
  }

  async findAll(userId: string, query: ExpenseQueryParams) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { userId };

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }

    if (query.startDate || query.endDate) {
      const dateFilter: Record<string, Date> = {};
      if (query.startDate) dateFilter.gte = new Date(query.startDate);
      if (query.endDate) dateFilter.lte = new Date(query.endDate);
      where.date = dateFilter;
    }

    const [total, items] = await Promise.all([
      this.prisma.expense.count({ where }),
      this.prisma.expense.findMany({
        where,
        include: { category: true },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const data = await Promise.all(
      items.map(async (item) => {
        if (!item.receiptImageKey) return item;
        const receiptImageUrl = await this.s3Service.generatePresignedGetUrl(
          item.receiptImageKey,
        );
        return { ...item, receiptImageUrl };
      }),
    );

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async update(userId: string, id: string, dto: UpdateExpenseDto) {
    const existing = await this.findOneOrThrow(userId, id);

    if (dto.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, userId },
      });
      if (!cat) {
        throw new NotFoundException('Category not found');
      }
    }

    let receiptImageUrl: string | undefined;
    if (dto.receiptImageKey) {
      receiptImageUrl = await this.s3Service.generatePresignedGetUrl(
        dto.receiptImageKey,
      );
    }

    let homeCurrencyAmount: number | undefined;
    let homeCurrencyCode: string | undefined;
    if (dto.amount !== undefined || dto.currency !== undefined) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { homeCurrency: true },
      });
      const homeCurrency = user?.homeCurrency ?? 'USD';
      const currencyToUse = dto.currency ?? existing.currency;
      const amountToUse = dto.amount ?? parseFloat(existing.amount.toString());
      const rate = await this.currencyService.getRate(currencyToUse, homeCurrency);
      homeCurrencyAmount = amountToUse * rate;
      homeCurrencyCode = homeCurrency;
    }

    return this.prisma.expense.update({
      where: { id },
      data: {
        ...(dto.vendor !== undefined && { vendor: dto.vendor }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
        ...(dto.receiptImageKey !== undefined && {
          receiptImageKey: dto.receiptImageKey,
        }),
        ...(receiptImageUrl !== undefined && { receiptImageUrl }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(homeCurrencyAmount !== undefined && { homeCurrencyAmount }),
        ...(homeCurrencyCode !== undefined && { homeCurrencyCode }),
      },
      include: { category: true },
    });
  }

  async remove(userId: string, id: string) {
    const expense = await this.findOneOrThrow(userId, id);

    if (expense.receiptImageKey) {
      await this.s3Service.deleteObject(expense.receiptImageKey);
    }

    return this.prisma.expense.delete({ where: { id } });
  }

  async uploadReceipt(userId: string, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    const ext = this.getExtension(file.mimetype);
    const key = `receipts/${userId}/${uuidv4()}.${ext}`;
    await this.s3Service.uploadBuffer(key, file.buffer, file.mimetype);
    const receiptImageUrl = await this.s3Service.generatePresignedGetUrl(key);
    return { receiptImageKey: key, receiptImageUrl };
  }

  async getMonthlySummary(userId: string): Promise<MonthlySummaryRow[]> {
    const rows = await this.prisma.$queryRaw<{ month: string; total: number; count: bigint }[]>`
      SELECT
        TO_CHAR(DATE_TRUNC('month', date), 'YYYY-MM') AS month,
        SUM(COALESCE("homeCurrencyAmount", amount))::float8 AS total,
        COUNT(*) AS count
      FROM "Expense"
      WHERE "userId" = ${userId}
        AND date >= NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', date)
      ORDER BY DATE_TRUNC('month', date) ASC
    `;
    return rows.map((r) => ({ month: r.month, total: Number(r.total), count: Number(r.count) }));
  }

  async getCategorySummary(
    userId: string,
    month: string,
  ): Promise<CategorySummaryItem[]> {
    const [year, mon] = month.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, mon - 1, 1));
    const endDate = new Date(Date.UTC(year, mon, 0, 23, 59, 59, 999));

    const expenses = await this.prisma.expense.findMany({
      where: { userId, date: { gte: startDate, lte: endDate } },
      include: { category: true },
    });

    const map = new Map<
      string,
      { name: string; color: string; icon: string | null; total: number; budgetAmount: number | null }
    >();

    for (const e of expenses) {
      const key = e.categoryId ?? '__none__';
      const amount = parseFloat((e.homeCurrencyAmount ?? e.amount).toString());
      const existing = map.get(key);
      if (existing) {
        existing.total += amount;
      } else {
        map.set(key, {
          name: e.category?.name ?? 'Uncategorized',
          color: e.category?.color ?? '#6B7280',
          icon: e.category?.icon ?? null,
          total: amount,
          budgetAmount: e.category?.budgetAmount
            ? parseFloat(e.category.budgetAmount.toString())
            : null,
        });
      }
    }

    return Array.from(map.entries())
      .map(([key, data]) => ({
        categoryId: key === '__none__' ? null : key,
        ...data,
      }))
      .sort((a, b) => b.total - a.total);
  }

  async exportCsv(
    userId: string,
    startDateStr?: string,
    endDateStr?: string,
  ): Promise<string> {
    let startDate: Date;
    let endDate: Date;

    if (startDateStr && endDateStr) {
      startDate = new Date(startDateStr);
      endDate = new Date(endDateStr);
      endDate.setHours(23, 59, 59, 999);
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const expenses = await this.prisma.expense.findMany({
      where: { userId, date: { gte: startDate, lte: endDate } },
      include: { category: true },
      orderBy: { date: 'desc' },
    });

    const escape = (v: unknown) =>
      `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Date', 'Vendor', 'Amount', 'Currency', 'Home Amount', 'Home Currency', 'Category', 'Notes']
      .map(escape)
      .join(',');
    const rows = expenses.map((e) =>
      [
        e.date.toISOString().split('T')[0],
        e.vendor,
        e.amount.toString(),
        e.currency,
        e.homeCurrencyCode && e.homeCurrencyCode !== e.currency ? e.homeCurrencyAmount?.toString() ?? '' : '',
        e.homeCurrencyCode && e.homeCurrencyCode !== e.currency ? e.homeCurrencyCode : '',
        e.category?.name ?? '',
        e.notes ?? '',
      ]
        .map(escape)
        .join(','),
    );

    return [header, ...rows].join('\n');
  }

  async getMonthlyRecap(userId: string, month: string): Promise<{ recap: string }> {
    const [year, mon] = month.split('-').map(Number);
    const prevMonthDate = mon === 1
      ? `${year - 1}-12`
      : `${year}-${String(mon - 1).padStart(2, '0')}`;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { homeCurrency: true },
    });
    const homeCurrency = user?.homeCurrency ?? 'USD';

    const [current, prev] = await Promise.all([
      this.getMonthlySummary(userId).then((rows) => rows.find((r) => r.month === month)),
      this.getMonthlySummary(userId).then((rows) => rows.find((r) => r.month === prevMonthDate)),
    ]);

    if (!current || current.total === 0) {
      return { recap: 'No expenses recorded for this month yet.' };
    }

    const categories = await this.getCategorySummary(userId, month);
    const categoryCtx = categories.map((c) => ({
      name: c.name,
      total: c.total,
      percentage: current.total > 0 ? (c.total / current.total) * 100 : 0,
      budgetAmount: c.budgetAmount,
    }));

    const recap = await this.aiService.generateRecap({
      month,
      homeCurrency,
      total: current.total,
      count: current.count,
      categories: categoryCtx,
      prevMonth: prevMonthDate,
      prevTotal: prev?.total ?? 0,
      prevCount: prev?.count ?? 0,
    });

    return { recap };
  }

  async getVendorInsights(userId: string): Promise<
    { name: string; count: number; total: number; average: number; lastDate: string }[]
  > {
    const since = new Date();
    since.setMonth(since.getMonth() - 12);

    const expenses = await this.prisma.expense.findMany({
      where: { userId, date: { gte: since } },
      select: {
        vendor: true,
        homeCurrencyAmount: true,
        amount: true,
        date: true,
      },
      orderBy: { date: 'desc' },
    });

    // Groups: { normalizedKey, canonicalName, entries[] }
    const groups: {
      normalizedKey: string;
      names: string[];
      total: number;
      dates: Date[];
    }[] = [];

    for (const e of expenses) {
      const normalized = normalizeVendor(e.vendor);
      const amount = parseFloat((e.homeCurrencyAmount ?? e.amount).toString());

      const match = groups.find(
        (g) => vendorSimilarity(g.normalizedKey, normalized) >= 0.8,
      );

      if (match) {
        match.names.push(e.vendor);
        match.total += amount;
        match.dates.push(e.date);
      } else {
        groups.push({
          normalizedKey: normalized,
          names: [e.vendor],
          total: amount,
          dates: [e.date],
        });
      }
    }

    return groups
      .map((g) => {
        // canonical name = most frequent original name in the group
        const freq = new Map<string, number>();
        for (const n of g.names) freq.set(n, (freq.get(n) ?? 0) + 1);
        const canonical = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const count = g.names.length;
        return {
          name: canonical,
          count,
          total: g.total,
          average: g.total / count,
          lastDate: g.dates[0].toISOString().split('T')[0],
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private async findOneOrThrow(userId: string, id: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, userId },
    });
    if (!expense) {
      throw new NotFoundException(`Expense with id "${id}" not found`);
    }
    return expense;
  }

  private getExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
    };
    return map[mimeType] ?? 'jpg';
  }
}
