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

    return {
      data: items,
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
