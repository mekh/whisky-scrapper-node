import { IsNotEmpty, IsString } from 'class-validator';

export class ConflictResolveDto {
  @IsString()
  @IsNotEmpty()
  public productId!: string;

  @IsString()
  @IsNotEmpty()
  public storeId!: string;

  @IsString()
  @IsNotEmpty()
  public attribute!: string;
}
