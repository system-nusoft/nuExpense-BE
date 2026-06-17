import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SignupDto } from './dto/signup.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', color: '#f59e0b', icon: 'utensils', sortOrder: 0 },
  { name: 'Transport', color: '#3b82f6', icon: 'car', sortOrder: 1 },
  { name: 'Shopping', color: '#ec4899', icon: 'shopping-bag', sortOrder: 2 },
  { name: 'Bills & Utilities', color: '#8b5cf6', icon: 'zap', sortOrder: 3 },
  { name: 'Entertainment', color: '#f97316', icon: 'film', sortOrder: 4 },
  { name: 'Health', color: '#10b981', icon: 'heart', sortOrder: 5 },
  { name: 'Travel', color: '#06b6d4', icon: 'plane', sortOrder: 6 },
  { name: 'Other', color: '#6b7280', icon: 'more-horizontal', sortOrder: 7 },
];

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async signup(dto: SignupDto): Promise<{ message: string; email: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      if (existing.isVerified) {
        throw new ConflictException('Email already in use');
      }
      // Unverified account exists — resend OTP and allow retry
      await this.issueOtp(existing.id, existing.email, existing.name ?? undefined);
      return { message: 'Verification code sent to your email', email: dto.email };
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        isVerified: false,
      },
    });

    await this.issueOtp(user.id, user.email, user.name ?? undefined);

    return { message: 'Verification code sent to your email', email: dto.email };
  }

  async verifyEmail(dto: VerifyOtpDto): Promise<AuthTokens & { user: object }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new BadRequestException('Invalid verification attempt');
    }

    if (user.isVerified) {
      throw new BadRequestException('Email is already verified');
    }

    const otpRecord = await this.prisma.otpCode.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      throw new BadRequestException('No verification code found. Please request a new one.');
    }

    if (otpRecord.expiresAt < new Date()) {
      await this.prisma.otpCode.deleteMany({ where: { userId: user.id } });
      throw new BadRequestException('Verification code has expired. Please request a new one.');
    }

    const isMatch = await bcrypt.compare(dto.code, otpRecord.code);
    if (!isMatch) {
      throw new BadRequestException('Invalid verification code');
    }

    // Mark verified, seed categories, clean up OTPs — all in one transaction
    const [verifiedUser] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true },
        select: {
          id: true,
          email: true,
          name: true,
          homeCurrency: true,
          isPremium: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.otpCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.category.createMany({
        data: DEFAULT_CATEGORIES.map((cat) => ({ userId: user.id, ...cat })),
        skipDuplicates: true,
      }),
    ]);

    const tokens = await this.generateTokens(verifiedUser.id, verifiedUser.email);
    return { ...tokens, user: verifiedUser };
  }

  async resendOtp(email: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Return success even if not found to avoid email enumeration
      return { message: 'If that email exists, a code has been sent' };
    }

    if (user.isVerified) {
      throw new BadRequestException('Email is already verified');
    }

    await this.issueOtp(user.id, user.email, user.name ?? undefined);
    return { message: 'Verification code resent' };
  }

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return null;

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return null;

    return { id: user.id, email: user.email, isVerified: user.isVerified };
  }

  async login(userId: string, email: string, isVerified: boolean): Promise<AuthTokens & { user: object }> {
    if (!isVerified) {
      // Resend OTP silently so the user can verify
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      await this.issueOtp(user.id, user.email, user.name ?? undefined);
      throw new UnauthorizedException('Please verify your email before logging in. A new code has been sent.');
    }

    const tokens = await this.generateTokens(userId, email);
    const user = await this.getMe(userId);
    return { ...tokens, user };
  }

  async refresh(userId: string, oldRefreshToken: string): Promise<AuthTokens> {
    const dbTokens = await this.prisma.refreshToken.findMany({ where: { userId } });

    let matchedTokenId: string | null = null;
    for (const dbToken of dbTokens) {
      const isMatch = await bcrypt.compare(oldRefreshToken, dbToken.token);
      if (isMatch) {
        matchedTokenId = dbToken.id;
        break;
      }
    }

    if (!matchedTokenId) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.delete({ where: { id: matchedTokenId } });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true },
    });

    return this.generateTokens(user.id, user.email);
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  async generateTokens(userId: string, email: string): Promise<AuthTokens> {
    const payload = { sub: userId, email };

    const accessExpiresIn = (this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    ) as unknown) as number;
    const refreshExpiresIn = (this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    ) as unknown) as number;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiresIn,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn,
      }),
    ]);

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.prisma.refreshToken.create({
      data: { token: tokenHash, userId, expiresAt },
    });

    return { accessToken, refreshToken };
  }

  async validateRefreshToken(userId: string, rawToken: string): Promise<boolean> {
    const dbTokens = await this.prisma.refreshToken.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
    });

    for (const dbToken of dbTokens) {
      const isMatch = await bcrypt.compare(rawToken, dbToken.token);
      if (isMatch) return true;
    }

    return false;
  }

  async getMe(userId: string): Promise<object> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
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

  private async issueOtp(userId: string, email: string, name?: string): Promise<void> {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashed = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.prisma.$transaction([
      this.prisma.otpCode.deleteMany({ where: { userId } }),
      this.prisma.otpCode.create({ data: { userId, code: hashed, expiresAt } }),
    ]);

    await this.mailService.sendVerificationOtp(email, otp, name);
  }
}
