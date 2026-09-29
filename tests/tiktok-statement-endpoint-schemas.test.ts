import { describe, expect, it } from 'vitest';
import {
  createStatementListQuery,
  createStatementOrderListQuery,
  createStatementTransactionDetailQuery,
  tiktokStatementEndpointUrl,
  TIKTOK_STATEMENT_ENDPOINT_PATHS,
} from '../src/core/tiktok-statement-endpoints';
import {
  StatementListResponseSchema,
  StatementOrderListResponseSchema,
  StatementTransactionDetailResponseSchema,
  extractStatementIds,
  extractStatementSkuDetailId,
  extractStatementSkuDetailRefs,
  TikTokMoneySchema,
} from '../src/core/tiktok-statement-endpoint-schemas';

// ─── Statement endpoints ─────────────────────────────────────────────

describe('TIKTOK_STATEMENT_ENDPOINT_PATHS', () => {
  it('has the expected paths', () => {
    expect(TIKTOK_STATEMENT_ENDPOINT_PATHS['statement-list']).toBe('/api/v1/pay/statement/list/detail');
    expect(TIKTOK_STATEMENT_ENDPOINT_PATHS['statement-order-list']).toBe('/api/v1/pay/statement/order/list');
    expect(TIKTOK_STATEMENT_ENDPOINT_PATHS['statement-transaction-detail']).toBe('/api/v1/pay/statement/transaction/detail');
  });
});

describe('createStatementListQuery', () => {
  it('uses observed defaults', () => {
    const query = createStatementListQuery({});
    expect(query).toEqual({
      pagination_type: '1',
      from: '0',
      size: '10',
      page_type: '5',
      need_total_amount: 'false',
      statement_version: '0',
    });
  });

  it('overrides defaults', () => {
    const query = createStatementListQuery({ from: 20, size: 50 });
    expect(query.from).toBe('20');
    expect(query.size).toBe('50');
  });
});

describe('createStatementOrderListQuery', () => {
  it('builds the captured statement drill-down query', () => {
    expect(createStatementOrderListQuery({
      statementId: 'statement-1',
      statementVersion: 3,
    })).toEqual({
      pagination_type: '1',
      from: '0',
      size: '50',
      terminal_type: '1',
      page_type: '6',
      statement_id: 'statement-1',
      settlement_status: '2',
      no_need_sku_record: 'false',
      need_total_amount: 'false',
      statement_version: '3',
    });
  });
});

describe('createStatementTransactionDetailQuery', () => {
  it('builds query with required statement_sku_detail_id', () => {
    const query = createStatementTransactionDetailQuery({ statementSkuDetailId: '12345' });
    expect(query).toEqual({
      terminal_type: '1',
      page_type: '9',
      statement_sku_detail_id: '12345',
      statement_version: '0',
    });
  });
});

describe('tiktokStatementEndpointUrl', () => {
  it('composes URL with identity and extra query', () => {
    const url = tiktokStatementEndpointUrl(
      'https://api16-normal-sg.tiktokshopglobalselling.com',
      'statement-list',
      { sellerId: '12345' },
      { from: '0', size: '10' },
    );
    expect(url).toContain('/api/v1/pay/statement/list/detail');
    expect(url).toContain('oec_seller_id=12345');
    expect(url).toContain('from=0');
    expect(url).toContain('size=10');
  });
});

// ─── Money schema ────────────────────────────────────────────────────

describe('TikTokMoneySchema', () => {
  it('validates a well-formed money object', () => {
    const money = { amount: '310.99', currency: 'THB', symbol: '฿' };
    expect(TikTokMoneySchema.safeParse(money).success).toBe(true);
  });

  it('rejects missing amount', () => {
    expect(TikTokMoneySchema.safeParse({ currency: 'THB' }).success).toBe(false);
  });

  it('accepts negative amounts as strings', () => {
    const money = { amount: '-524.06', currency: 'THB' };
    expect(TikTokMoneySchema.safeParse(money).success).toBe(true);
  });
});

// ─── Statement list ──────────────────────────────────────────────────

describe('StatementListResponseSchema', () => {
  const validResponse = {
    code: 0,
    message: 'success',
    data: {
      search_next_cursor: 'cursor-abc',
      search_next_has_more: true,
      search_previous_cursor: 'cursor-prev',
      search_previous_has_more: false,
      total_record: 25,
      statement_records: [
        {
          statement_id: '7678105595576076033',
          statement_version: 0,
          bill_period: '1787788799000',
          settle_amount: { amount: '0', currency: 'THB' },
          earning_amount: { amount: '0', currency: 'THB' },
          fee_amount: { amount: '0', currency: 'THB' },
          payment_id: '0',
          payment_status: 20,
        },
      ],
    },
  };

  it('validates a well-formed response', () => {
    expect(StatementListResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('rejects missing statement_records', () => {
    const invalid = { ...validResponse, data: { ...validResponse.data, statement_records: undefined } };
    expect(StatementListResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects missing statement_id in a record', () => {
    const invalid = {
      ...validResponse,
      data: {
        ...validResponse.data,
        statement_records: [{ statement_version: 0 }],
      },
    };
    expect(StatementListResponseSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('extractStatementIds', () => {
  it('extracts statement_id and statement_version pairs', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        statement_records: [
          { statement_id: 'aaa', statement_version: 0 },
          { statement_id: 'bbb', statement_version: 1 },
        ],
      },
    };
    expect(extractStatementIds(response)).toEqual([
      { statementId: 'aaa', statementVersion: 0 },
      { statementId: 'bbb', statementVersion: 1 },
    ]);
  });

  // §2.5 dumps 契约：parse 失败不再静默返 []（会让 "no more data" 与 "contract error"
  // 不可区分，调用方继续按 0 行同步会静默丢结算记录）。
  it('throws on invalid response (parse failure surfaces as error)', () => {
    expect(() => extractStatementIds({})).toThrow(/schema\/parse failed/);
  });
});

// ─── Statement order/SKU bridge list ─────────────────────────────────

describe('StatementOrderListResponseSchema', () => {
  const response = {
    code: 0,
    message: 'success',
    data: {
      total_record: 2,
      search_next_has_more: false,
      order_records: [
        {
          statement_id: 'statement-1',
          statement_version: 3,
          trade_order_id: 'order-1',
          sku_records: [
            { statement_sku_detail_id: 'detail-1', sku_id: 'sku-1' },
            { statement_sku_detail_id: 'detail-2', sku_id: 'sku-2' },
          ],
        },
        { statement_id: 'statement-1', statement_version: 3 },
      ],
    },
  };

  it('validates nested SKU refs and ignores fee-only records', () => {
    const parsed = StatementOrderListResponseSchema.parse(response);
    expect(extractStatementSkuDetailRefs(parsed, {
      statementId: 'statement-1',
      statementVersion: 3,
    })).toEqual([
      { statementSkuDetailId: 'detail-1', statementId: 'statement-1', statementVersion: 3 },
      { statementSkuDetailId: 'detail-2', statementId: 'statement-1', statementVersion: 3 },
    ]);
  });

  it('rejects empty nested detail IDs', () => {
    expect(StatementOrderListResponseSchema.safeParse({
      ...response,
      data: {
        ...response.data,
        order_records: [{ sku_records: [{ statement_sku_detail_id: '' }] }],
      },
    }).success).toBe(false);
  });

  it('rejects refs from a different statement identity', () => {
    const parsed = StatementOrderListResponseSchema.parse(response);
    expect(() => extractStatementSkuDetailRefs(parsed, {
      statementId: 'different',
      statementVersion: 3,
    })).toThrow('identity mismatch');
  });
});

// ─── Statement transaction detail ────────────────────────────────────

describe('StatementTransactionDetailResponseSchema', () => {
  const validResponse = {
    code: 0,
    message: 'success',
    data: {
      sku_record: {
        statement_sku_detail_id: '7677633448508458759',
        statement_id: '7678105595576076033',
        statement_version: 0,
        sku_id: '1734012371986580534',
        trade_order_id: '585710550876587729',
        product_name: 'Test Product',
        sku_name: 'Test SKU',
        quantity: 1,
        settlement_amount: { amount: '0', currency: 'THB' },
        earning_amount: { amount: '0', currency: 'THB' },
        fees: { amount: '0', currency: 'THB' },
        in_come: { fee_list: [], amount: { amount: '0', currency: 'THB' } },
        out_come: { fee_list: [], amount: { amount: '0', currency: 'THB' } },
        bill_period: '1787788799000',
        settlement_status: 2,
        placed_time: '1787587876706',
      },
    },
    seller_web_cut_flow: true,
    seller_app_cut_flow: false,
  };

  it('validates a well-formed response', () => {
    expect(StatementTransactionDetailResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('rejects missing sku_record', () => {
    const invalid = { ...validResponse, data: {} };
    expect(StatementTransactionDetailResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects missing statement_sku_detail_id in sku_record', () => {
    const invalid = {
      ...validResponse,
      data: { sku_record: { ...validResponse.data.sku_record, statement_sku_detail_id: undefined } },
    };
    expect(StatementTransactionDetailResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('preserves top-level cut_flow booleans', () => {
    const parsed = StatementTransactionDetailResponseSchema.parse(validResponse);
    expect(parsed.seller_web_cut_flow).toBe(true);
    expect(parsed.seller_app_cut_flow).toBe(false);
  });
});

describe('extractStatementSkuDetailId', () => {
  it('extracts the ID from a valid response', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        sku_record: {
          statement_sku_detail_id: 'test-id-123',
          statement_id: 'stmt-1',
          statement_version: 0,
          sku_id: 'sku-1',
        },
      },
    };
    expect(extractStatementSkuDetailId(response)).toBe('test-id-123');
  });

  it('returns null for invalid response', () => {
    expect(extractStatementSkuDetailId({})).toBeNull();
  });
});
