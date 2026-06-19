import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);
  private readonly cache = new Map<
    string,
    { rates: Record<string, number>; expiresAt: number }
  >();

  async getRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const rates = await this.getRates(from);
    const rate = rates[to];
    if (!rate) {
      this.logger.warn(`No rate found for ${from} → ${to}, defaulting to 1`);
      return 1;
    }
    return rate;
  }

  private async getRates(base: string): Promise<Record<string, number>> {
    const cached = this.cache.get(base);
    if (cached && Date.now() < cached.expiresAt) return cached.rates;

    const res = await fetch(
      `https://open.er-api.com/v6/latest/${base}`,
    );
    if (!res.ok) {
      this.logger.error(`Exchange rate API error for base ${base}: ${res.status}`);
      return {};
    }
    const json = (await res.json()) as { result: string; rates: Record<string, number> };
    if (json.result !== 'success') {
      this.logger.error(`Exchange rate API returned non-success for base ${base}`);
      return {};
    }
    // rates already includes base: 1
    this.cache.set(base, { rates: json.rates, expiresAt: Date.now() + 60 * 60 * 1000 });
    return json.rates;
  }
}
