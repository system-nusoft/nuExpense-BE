// This DTO is used for the scan endpoint response shape (not a request body DTO)
export class ScanExpenseResponseDto {
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  suggestedCategoryId: string | null;
  confidence: number;
  rawText: string;
  receiptImageKey: string;
}
