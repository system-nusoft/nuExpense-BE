import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ReorderItemDto } from './dto/reorder-categories.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.category.findMany({
      where: { userId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async create(userId: string, dto: CreateCategoryDto) {
    const existing = await this.prisma.category.findUnique({
      where: { userId_name: { userId, name: dto.name } },
    });

    if (existing) {
      throw new ConflictException(`Category "${dto.name}" already exists`);
    }

    return this.prisma.category.create({
      data: {
        userId,
        name: dto.name,
        color: dto.color ?? '#6366f1',
        icon: dto.icon,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    await this.findOneOrThrow(userId, id);

    if (dto.name) {
      const existing = await this.prisma.category.findUnique({
        where: { userId_name: { userId, name: dto.name } },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(`Category "${dto.name}" already exists`);
      }
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  async reorder(userId: string, items: ReorderItemDto[]) {
    // Verify all categories belong to user
    const ids = items.map((i) => i.id);
    const categories = await this.prisma.category.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true },
    });

    if (categories.length !== ids.length) {
      throw new NotFoundException('One or more categories not found');
    }

    return this.prisma.$transaction(
      items.map((item) =>
        this.prisma.category.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );
  }

  async remove(userId: string, id: string) {
    await this.findOneOrThrow(userId, id);

    // Re-assign all expenses in this category to null
    await this.prisma.expense.updateMany({
      where: { categoryId: id, userId },
      data: { categoryId: null },
    });

    return this.prisma.category.delete({ where: { id } });
  }

  private async findOneOrThrow(userId: string, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, userId },
    });
    if (!category) {
      throw new NotFoundException(`Category with id "${id}" not found`);
    }
    return category;
  }
}
