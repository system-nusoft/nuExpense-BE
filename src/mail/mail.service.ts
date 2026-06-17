import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MailService {
  private readonly client: SESClient;
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly otpTemplate: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.getOrThrow<string>('SES_FROM_MAIL');

    this.client = new SESClient({
      region: this.config.get<string>('AWS_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });

    this.otpTemplate = fs.readFileSync(
      path.join(__dirname, 'templates', 'verification-otp.html'),
      'utf-8',
    );
  }

  async sendVerificationOtp(email: string, otp: string, name?: string): Promise<void> {
    const html = this.otpTemplate
      .replace(/{{displayName}}/g, name ?? email)
      .replace(/{{otp}}/g, otp)
      .replace(/{{year}}/g, new Date().getFullYear().toString());

    const command = new SendEmailCommand({
      Source: `"nuExpense" <${this.from}>`,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Your nuExpense verification code', Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
        },
      },
    });

    await this.client.send(command);
    this.logger.log(`Verification OTP sent to ${email}`);
  }
}
