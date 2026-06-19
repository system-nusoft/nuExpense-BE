import { IsString, IsOptional, IsHexColor, IsInt, IsNumber, IsPositive, Min } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  budgetAmount?: number;
}
