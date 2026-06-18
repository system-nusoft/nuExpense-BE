import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { AiService } from '../ai/ai.service';
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
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
    private readonly aiService: AiService,
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
    // Verify category belongs to user if provided
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

    return this.prisma.expense.create({
      data: {
        userId,
        vendor: dto.vendor,
        amount: dto.amount,
        currency: dto.currency ?? 'USD',
        date: new Date(dto.date),
        categoryId: dto.categoryId ?? null,
        receiptImageKey: dto.receiptImageKey ?? null,
        receiptImageUrl,
        notes: dto.notes ?? null,
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
    await this.findOneOrThrow(userId, id);

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
        SUM(amount)::float8 AS total,
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
      { name: string; color: string; icon: string | null; total: number }
    >();

    for (const e of expenses) {
      const key = e.categoryId ?? '__none__';
      const amount = parseFloat(e.amount.toString());
      const existing = map.get(key);
      if (existing) {
        existing.total += amount;
      } else {
        map.set(key, {
          name: e.category?.name ?? 'Uncategorized',
          color: e.category?.color ?? '#6B7280',
          icon: e.category?.icon ?? null,
          total: amount,
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
    const header = ['Date', 'Vendor', 'Amount', 'Currency', 'Category', 'Notes']
      .map(escape)
      .join(',');
    const rows = expenses.map((e) =>
      [
        e.date.toISOString().split('T')[0],
        e.vendor,
        e.amount.toString(),
        e.currency,
        e.category?.name ?? '',
        e.notes ?? '',
      ]
        .map(escape)
        .join(','),
    );

    return [header, ...rows].join('\n');
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
