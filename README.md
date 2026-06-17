# nuExpense Backend

AI-powered expense tracking API built with NestJS, Prisma, PostgreSQL, AWS S3, and Anthropic Claude.

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your actual values (see Environment Variables section below).

### 3. Run database migrations

```bash
npx prisma migrate dev --name init
```

This creates all tables and seeds nothing (seed your categories via the API on signup).

### 4. Start development server

```bash
npm run start:dev
```

The API runs at `http://localhost:3001` with global prefix `/api`.

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/nuexpense` |
| `JWT_ACCESS_SECRET` | Secret for signing access tokens | Any long random string |
| `JWT_REFRESH_SECRET` | Secret for signing refresh tokens | A different long random string |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `7d` |
| `AWS_REGION` | AWS region for S3 | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS IAM access key | — |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM secret key | — |
| `AWS_S3_BUCKET` | S3 bucket name (private) | `nuexpense-receipts` |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude vision | — |
| `PORT` | Port to listen on | `3001` |
| `FRONTEND_URL` | Allowed CORS origin | `http://localhost:3000` |

---

## API Endpoint Summary

### Auth — `/api/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/signup` | No | Create account, returns tokens + user |
| POST | `/login` | No | Login, returns tokens + user |
| POST | `/refresh` | RefreshToken | Rotate refresh token, returns new pair |
| POST | `/logout` | JWT | Invalidate all refresh tokens |
| GET | `/me` | JWT | Get current user profile |

### Users — `/api/users`

| Method | Path | Auth | Description |
|---|---|---|---|
| PATCH | `/me` | JWT | Update name or homeCurrency |

### Categories — `/api/categories`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | JWT | List all categories (sorted by sortOrder) |
| POST | `/` | JWT | Create a category |
| PATCH | `/reorder` | JWT | Reorder categories — body: `{ items: [{id, sortOrder}] }` |
| PATCH | `/:id` | JWT | Update a category |
| DELETE | `/:id` | JWT | Delete category (expenses set to uncategorized) |

### Expenses — `/api/expenses`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/scan` | JWT | Upload receipt image (multipart field: `receipt`), returns AI-parsed draft |
| POST | `/` | JWT | Persist a confirmed expense |
| GET | `/` | JWT | List expenses — query: `page`, `limit`, `categoryId`, `startDate`, `endDate` |
| PATCH | `/:id` | JWT | Update an expense |
| DELETE | `/:id` | JWT | Delete expense (also removes S3 object if present) |

#### Scan response shape
```json
{
  "vendor": "Starbucks",
  "amount": 12.50,
  "currency": "USD",
  "date": "2026-06-15",
  "suggestedCategoryId": "clxxx...",
  "confidence": 0.95,
  "rawText": "...",
  "receiptImageKey": "receipts/{userId}/{uuid}.jpg"
}
```

Pass `receiptImageKey` in the subsequent `POST /expenses` body to link the receipt.

---

## Deployment on Railway

1. Create a new Railway project and link this repo.
2. Add a PostgreSQL service in Railway; copy the `DATABASE_URL` to your service env vars.
3. Set all other environment variables in Railway's environment settings.
4. Add a **release command** (runs before each deploy starts serving traffic):
   ```
   npx prisma migrate deploy
   ```
5. Set the **start command** to:
   ```
   node dist/main
   ```
   Or use the default `npm run start:prod`.

Railway will automatically build via `npm run build` (configured in `package.json`).

### S3 Bucket Policy

The S3 bucket must remain **private**. The backend generates pre-signed URLs for all uploads and downloads — never expose bucket objects publicly. Ensure your IAM user has these permissions:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::your-bucket-name/*"
}
```
