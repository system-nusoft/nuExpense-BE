import { Module } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { S3Module } from '../s3/s3.module';
import { AiModule } from '../ai/ai.module';
import { CurrencyModule } from '../currency/currency.module';

@Module({
  imports: [S3Module, AiModule, CurrencyModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
