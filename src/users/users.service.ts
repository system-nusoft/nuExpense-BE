import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async updateMe(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.homeCurrency !== undefined && { homeCurrency: dto.homeCurrency }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        homeCurrency: true,
        isPremium: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
