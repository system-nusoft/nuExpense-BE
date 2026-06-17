import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsPositive,
  Min,
} from 'class-validator';

export class CreateExpenseDto {
  @IsString()
  vendor: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  receiptImageKey?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
