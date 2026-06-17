import { IsString, IsOptional, Length } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  homeCurrency?: string;
}
