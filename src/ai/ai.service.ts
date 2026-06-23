import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';

export interface RecapContext {
  month: string;
  homeCurrency: string;
  total: number;
  count: number;
  categories: { name: string; total: number; percentage: number; budgetAmount: number | null }[];
  prevMonth: string;
  prevTotal: number;
  prevCount: number;
}

export interface ReceiptAnalysisResult {
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  suggestedCategoryId: string | null;
  confidence: number;
  rawText: string;
}

@Injectable()
export class AiService {
  private readonly client: Groq;
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly configService: ConfigService) {
    this.client = new Groq({
      apiKey: this.configService.getOrThrow<string>('GROQ_API_KEY'),
    });
  }

  async analyzeReceipt(
    imageBase64: string,
    mimeType: string,
    categories: { id: string; name: string }[],
  ): Promise<ReceiptAnalysisResult> {
    const categoryList = categories
      .map((c) => `- id: "${c.id}", name: "${c.name}"`)
      .join('\n');

    const prompt = `You are an expert receipt parser. Analyze this receipt image and extract the following information.

Available expense categories:
${categoryList}

Extract and return ONLY a valid JSON object (no markdown, no extra text) with these exact fields:
{
  "vendor": "store or restaurant name",
  "amount": 0.00,
  "currency": "USD",
  "date": "YYYY-MM-DD",
  "suggestedCategoryId": "the id from the category list that best matches this expense, or null if none fit",
  "confidence": 0.95,
  "rawText": "all text found on the receipt"
}

Rules:
- amount must be a number (the total amount paid)
- currency should be a 3-letter ISO code (default to USD if not visible)
- date must be in YYYY-MM-DD format (use today's date if not visible)
- confidence is a float from 0.0 to 1.0 indicating how confident you are in the extraction
- suggestedCategoryId must be one of the exact id values from the list above, or null
- Return ONLY the JSON object, nothing else`;

    const completion = await this.client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const responseText = completion.choices[0]?.message?.content ?? '';

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      const parsed = JSON.parse(jsonMatch[0]) as ReceiptAnalysisResult;
      return {
        vendor: parsed.vendor || 'Unknown Vendor',
        amount: typeof parsed.amount === 'number' ? parsed.amount : 0,
        currency: parsed.currency || 'USD',
        date: parsed.date || new Date().toISOString().split('T')[0],
        suggestedCategoryId: parsed.suggestedCategoryId || null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        rawText: parsed.rawText || responseText,
      };
    } catch (error) {
      this.logger.error('Failed to parse AI response', error);
      return {
        vendor: 'Unknown Vendor',
        amount: 0,
        currency: 'USD',
        date: new Date().toISOString().split('T')[0],
        suggestedCategoryId: null,
        confidence: 0,
        rawText: responseText,
      };
    }
  }

  async generateRecap(ctx: RecapContext): Promise<string> {
    const fmt = (n: number) =>
      new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

    const monthLabel = new Date(`${ctx.month}-01`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const prevMonthLabel = new Date(`${ctx.prevMonth}-01`).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const categoryLines = ctx.categories
      .map((c) => {
        const budgetNote = c.budgetAmount
          ? c.total > c.budgetAmount
            ? ` (OVER budget of ${ctx.homeCurrency} ${fmt(c.budgetAmount)})`
            : ` (budget: ${ctx.homeCurrency} ${fmt(c.budgetAmount)}, ${Math.round((c.total / c.budgetAmount) * 100)}% used)`
          : '';
        return `- ${c.name}: ${ctx.homeCurrency} ${fmt(c.total)} (${c.percentage.toFixed(1)}%)${budgetNote}`;
      })
      .join('\n');

    const changeNote = ctx.prevTotal > 0
      ? `${ctx.total > ctx.prevTotal ? '+' : ''}${(((ctx.total - ctx.prevTotal) / ctx.prevTotal) * 100).toFixed(1)}% vs ${prevMonthLabel} (${ctx.homeCurrency} ${fmt(ctx.prevTotal)}, ${ctx.prevCount} expenses)`
      : `No data for ${prevMonthLabel}`;

    const prompt = `You are a personal finance assistant. Write a concise 3-4 sentence monthly spending recap based on this data.

Month: ${monthLabel}
Home currency: ${ctx.homeCurrency}
Total spent: ${ctx.homeCurrency} ${fmt(ctx.total)} across ${ctx.count} expense${ctx.count !== 1 ? 's' : ''}
Month-over-month: ${changeNote}

Category breakdown:
${categoryLines}

Rules:
- Be specific with numbers and percentages
- Mention notable changes vs last month
- Call out any over-budget categories
- No greeting, no sign-off, no markdown — plain text only
- Maximum 4 sentences`;

    const completion = await this.client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    return completion.choices[0]?.message?.content?.trim() ?? 'Unable to generate recap.';
  }
}
