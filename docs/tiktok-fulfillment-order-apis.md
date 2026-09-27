# TikTok Seller Center — fulfillment/order/get & order/history

> 记录日期：2026-09-26  
> 来源：seller.tiktokshopglobalselling.com 实际抓包  
> 对应 Zod schema：`src/core/tiktok-order-endpoint-schemas.ts`

## 0. 本次实际样本与 review 结论

本次样本订单：`586172232072332674`，订单行：`586172232072398210`。

两份 response 已按脱敏方式记录在本文对应章节中。

样本校验结果：

- `order/get`：`code=0`，`data.main_order` 有 1 条；`main_order_status=102`，同时存在 `reverse_module.reverse_status=4`，表示订单主体仍是有效订单但已进入退货/退款流程，不应按“已取消订单”跳过。
- `order/history`：`code=0`，`total_count=7` 且返回 7 条事件，时间按倒序排列；退货申请事件包含 `detail`、`elements` 和 2 张证据图片。

当前逻辑 review：

1. 请求方法、路径、订单 ID 传递和成功业务码判断与样本一致。
2. `main_order_status=104` 的取消订单过滤不会误伤本样本的售后订单，这一点符合当前 response。
3. 生产链路现在会在上传前调用 `OrderGetResponseSchema` / `OrderHistoryResponseSchema`；结构异常但 HTTP 200、`code=0` 的 body 会进入失败队列，不会上传。
4. 当前 URL builder 实际发送的公共参数是 `aid=6556`、`language=zh-CN`、`app_name=i18n_ecom_shop` 等；本文旧版抓包说明中的 `aid=4068` 已不再代表当前代码，以下请求说明按当前 builder 记录。

---

## 1. `api/fulfillment/order/get`（订单详情）

- **Method**: `POST`
- **URL**: `https://seller.tiktokshopglobalselling.com/api/fulfillment/order/get`
- **Query params**: 当前 builder 会附带 `locale=zh-CN&language=zh-CN&aid=6556&app_name=i18n_ecom_shop&device_platform=web&cookie_enabled=true&oec_seller_id={seller_id}&seller_id={seller_id}`
- **Body**: `{"main_order_id": ["<order_id_1>", "<order_id_2>", ...]}`

### 1.1 Response 结构

```jsonc
{
  "code": 0,
  "message": "success",
  "data": {
    "main_order": [
      {
        "main_order_id": "586172232072332674",

        // ── 订单标识映射 ──
        "trade_order_id_mapper": {
          "main_order_id": "586172232072332674",
          "order_line_ids": ["586172232072398210"]
        },
        "fulfill_unit_id_mapper": [
          {
            "fulfill_unit_id": "1211732997698717058",
            "order_line_id": ["586172232072398210"],
            "package_id": "3350208314986759554"
          }
        ],

        // ── 交易信息 ──
        "trade_order_module": {
          "main_order_id": "586172232072332674",
          "create_time": "1789923447",       // Unix timestamp (seconds)
          "payment_time": "1790349731",
          "pay_method": "Cash on delivery",
          "update_time": "1790349731000",     // Unix timestamp (ms)
          "platform": 1,
          "business_line": 1,
          "sale_region": "VN",
          "main_order_type": 0,
          "fulfillment_type": 0,
          "latest_rts_time": "1790096248",    // 最迟 RTS 时间
          "latest_tts_time": "1790265599",    // 最迟 TTS 时间
          "close_sla_time": "1790611199",
          "need_invoice_flag": false,
          "shipping_fee": {
            "format_price": "0₫",
            "price_val": "0",
            "currency": "VND",
            "symbol": "₫"
          }
        },

        // ── 订单状态（按 order_line_id 维度）──
        "order_status_module": [
          {
            "order_line_id": "586172232072398210",
            "main_order_status": 102,
            "main_sub_order_status": 310,
            "sku_display_status": 122
          }
        ],

        // ── SKU 信息 ──
        "sku_module": [
          {
            "sku_id": "1737303421188539522",
            "order_line_ids": ["586172232072398210"],
            "product_name": "Áo Polo Nam Ngắn Tay ...",
            "sku_name": "Nâu, XL 65-72.5 kg",
            "product_image": { /* 图片对象 */ },
            "product_type": 0,
            "quantity": 1,
            "sku_unit_price":  { "format_price": "539.310₫", "price_val": "539310", "currency": "VND", "symbol": "₫" },
            "sku_total_price": { "format_price": "539.310₫", "price_val": "539310.00", "currency": "VND", "symbol": "₫" },
            "product_id": "1737303446962537602",
            "dangerous_good_level": 0
          }
        ],

        // ── 履约信息 ──
        "fulfillment_module": [
          {
            "fulfill_unit_id": "1211732997698717058",
            "print_time": "1789967261415",
            "rts_time": "1789967237630",
            "create_time": "1789923448568",
            "update_time": "1790420178583",
            "fulfillment_status_v2": 17000,
            "ship_exception_code": 0,
            "total_order_count": 1,
            "total_item_count": 1,
            "shop_order_count": 1,
            "shop_item_count": 1
          }
        ],

        // ── 物流/配送信息 ──
        "delivery_module": [
          {
            "fulfill_unit_id": "1211732997698717058",
            "pkg_attr": {
              "dimension": { "length": "24", "width": "11", "height": "5", "unit": 1 },
              "weight": { "weight": "260", "unit": 1 }
            },
            "shipping_fee": {},
            "tracking_no": "857661067034",
            "warehouse_region": "CN",
            "buyer_region": "VN",
            "receipt_id": "1211732997698717058",
            "warehouse_id": "7680121936135325460",
            "warehouse_name": "优航义乌仓",
            "last_tracking_no": "857661067034",
            "logistics_service_info": {
              "logistics_service_id": "7156147842033714945",
              "logistics_service_type": 0,
              "logistics_service_name": "全球经济运输服务",
              "logistics_service_level": "经济运输",
              "logistics_service_delivery_option": 3,
              "pickup_type": 2
            },
            "shipment_provider_info": {
              "id": "7439297584469903122",
              "name": "Wise Express - DCS",
              "icon_url": "https://..."
            },
            "warehouse_sub_type": 3,
            "payment_total": { "format_price": "539.310₫", "price_val": "539310", "currency": "VND", "symbol": "₫" },
            "pickup_type": 2
          }
        ],

        // ── 退货/逆向模块 ──
        "reverse_module": [
          {
            "reverse_order_id": "4042453493777204610",
            "order_line_ids": ["586172232072398210"],
            "reverse_status": 4,
            "reverse_type": 3,
            "reverse_tab_status": 2,
            "reverse_reason": "商品与描述不符",
            "reverse_from": 1,
            "cancelled_time": "1790355116",
            "seller_auto_approve_time": "1790441516",
            "canceled_during_status": "<UNSET>"
          }
        ],

        // ── 价格模块 ──
        "price_module": {
          "main_order_id": "586172232072332674",
          "sub_total":    { "format_price": "539.310₫", "price_val": "539310", "currency": "VND", "symbol": "₫" },
          "grand_total":  { "format_price": "539.310₫", "price_val": "539310", "currency": "VND", "symbol": "₫" },
          "shipping_fee": { "format_price": "0₫", "price_val": "0", "currency": "VND", "symbol": "₫" },
          "platform_discount_total": { "format_price": "56.897₫", "price_val": "56897", "currency": "VND", "symbol": "₫" },
          "seller_discount_total":   { "format_price": "417.751₫", "price_val": "417751", "currency": "VND", "symbol": "₫" },
          "main_order_origin_sale_price": { "format_price": "1.013.958₫", "price_val": "1013958", "currency": "VND", "symbol": "₫" },
          "shipping_origin_fee":         { "format_price": "15.000₫", "price_val": "15000", "currency": "VND", "symbol": "₫" },
          "shipping_fee_discount_seller":   { "format_price": "0₫", "price_val": "0", "currency": "VND", "symbol": "₫" },
          "shipping_fee_discount_platform": { "format_price": "15.000₫", "price_val": "15000", "currency": "VND", "symbol": "₫" },
          "promotion_infos": [
            { "promotion_name": "新客优惠券 2026/09/02 02:46:33", "promotion_cost": "12.168₫", "promotion_type": 1 },
            { "promotion_name": "商家秒杀活动 2026/09/01 21:36:22[auto_6]", "promotion_cost": "405.583₫", "promotion_type": 1 }
          ]
        },

        // ── 备注模块 ──
        "note_module": {
          "main_order_id": "586172232072332674",
          "has_seller_note": false,
          "has_seller_flag": false,
          "has_buyer_note": false
        },

        // ── 操作模块 ──
        "action_module": {
          "main_order_id": "586172232072332674",
          "action_list": [1000, 400, 900, 300, 140],
          "buyer_im_action_link": "/chat?..."
        },

        // ── 买家信息 ──
        "buyer_info_module": {
          "shipping_address": {
            "id": "0",
            "items": [
              { "key": "name", "value": "T**** T***" },
              { "key": "phone", "value": "(+84)965****68" },
              { "key": "address", "value": "**********************************" },
              { "key": "address_detail", "value": "***************************************" },
              { "key": "default", "value": "0" },
              { "key": "phone_region_code", "value": "" },
              { "key": "plain_phone", "value": "(+84)965****68" },
              { "key": "plain_alternate_phone", "value": "" }
            ],
            "region": { "name": "Việt Nam", "geoname_id": "1562822", "code": "VN" },
            "districts": [
              { "name": "Hà Nội", "geoname_id": "1581129", "district_key": "geo_l1" },
              { "name": "*************", "geoname_id": "117612841", "district_key": "geo_l3" }
            ],
            "address_id": "7792906262497996804",
            "pudo_id": "0",
            "address_type": 0,
            "longitude": "105.8081635703462",
            "latitude": "21.064743261912216"
          },
          "buyer_nickname": "m**********6",
          "avatar": { "height": 200, "width": 200, "uri": "tos-alisg-avt-0068/...", "url_list": ["..."] },
          "delivery_preference": { "drop_off_location": "" },
          "cpf": "",
          "cpf_name": ""
        },

        // ── 物流动态 ──
        "logistics_info_module": [
          {
            "fulfill_unit_id": "1211732997698717058",
            "logistics_detail_item": {
              "timestamp": 1790349667000,
              "display_msg": "你的包裹已送达！"
            }
          }
        ],

        // ── 履约行（与 sku_module 类似但按 fulfill_unit 组织）──
        "fulfill_line_module": [
          {
            "sku_id": "1737303421188539522",
            "order_line_ids": ["586172232072398210"],
            "product_name": "Áo Polo Nam ...",
            "sku_name": "Nâu, XL 65-72.5 kg",
            "product_image": { /* 图片对象 */ },
            "product_type": 0,
            "quantity": 1,
            "sku_unit_price": { ... },
            "sku_total_price": { ... },
            "product_id": "1737303446962537602",
            "dangerous_good_level": 0
          }
        ],

        // ── 打印标签 ──
        "print_label_module": [
          {
            "fulfill_unit_id": "1211732997698717058",
            "batch_id": "",
            "purchase_time": "1789967238",
            "label_status": 50,
            "picking_list_status": 0,
            "packing_list_status": 0
          }
        ],

        // ── 提醒模块 ──
        "reminder_module": [
          { "order_line_id": "586172232072398210" }
        ]
      }
    ]
  }
}
```

### 1.2 关键字段说明

| 字段路径 | 类型 | 说明 |
|---|---|---|
| `data.main_order[].main_order_id` | string | 主订单 ID |
| `data.main_order[].trade_order_module.create_time` | string (unix seconds) | 创建时间 |
| `data.main_order[].trade_order_module.payment_time` | string (unix seconds) | 付款时间 |
| `data.main_order[].trade_order_module.sale_region` | string | 销售区域 (VN/TH/...) |
| `data.main_order[].order_status_module[].main_order_status` | int | 主订单状态码 |
| `data.main_order[].order_status_module[].main_sub_order_status` | int | 子订单状态码 |
| `data.main_order[].order_status_module[].sku_display_status` | int | SKU 展示状态 |
| `data.main_order[].sku_module[].sku_id` | string | SKU ID |
| `data.main_order[].sku_module[].product_id` | string | 商品 ID |
| `data.main_order[].sku_module[].quantity` | int | 购买数量 |
| `data.main_order[].fulfillment_module[].fulfillment_status_v2` | int | 履约状态码 |
| `data.main_order[].delivery_module[].tracking_no` | string | 物流单号 |
| `data.main_order[].delivery_module[].warehouse_name` | string | 仓库名 |
| `data.main_order[].delivery_module[].shipment_provider_info.name` | string | 物流商名 |
| `data.main_order[].reverse_module[].reverse_status` | int | 退货状态 |
| `data.main_order[].reverse_module[].reverse_reason` | string | 退货原因 |
| `data.main_order[].price_module.grand_total.price_val` | string (decimal) | 实付金额（最小货币单位） |
| `data.main_order[].price_module.seller_discount_total.price_val` | string | 商家折扣总额 |
| `data.main_order[].price_module.platform_discount_total.price_val` | string | 平台折扣总额 |
| `data.main_order[].buyer_info_module.buyer_nickname` | string | 买家昵称（脱敏） |
| `data.main_order[].buyer_info_module.shipping_address` | object | 收货地址（脱敏） |

### 1.3 Money 对象格式

所有金额字段统一格式：

```jsonc
{
  "format_price": "539.310₫",  // 带符号的本地化展示
  "price_val": "539310",       // 最小货币单位（字符串），VND 无小数
  "currency": "VND",
  "symbol": "₫"
}
```

---

## 2. `api/v1/fulfillment/order/history`（订单历史）

- **Method**: `POST`
- **URL**: `https://seller.tiktokshopglobalselling.com/api/v1/fulfillment/order/history`
- **Query params**: 当前页面请求使用 `aid=4068&locale=zh-CN&oec_seller_id={seller_id}&seller_id={seller_id}`
- **JSON body**: `{ "main_order_id": "{order_id}", "offset": 0, "page_size": 10 }`

### 2.1 Response 结构

```jsonc
{
  "code": 0,
  "message": "success",
  "data": {
    "total_count": 7,
    "order_history": [
      {
        "description": "退款完成",
        "trans_time": "2026/9/26 18:56:17",    // 展示用时间
        "timestamp": 1790420177                  // Unix timestamp (seconds)
      },
      {
        "description": "客户已将退货包裹寄送给商家",
        "trans_time": "2026/9/26 18:56:13",
        "timestamp": 1790420173
      },
      {
        "description": "TikTok Shop 已根据适用政策自动批准",
        "trans_time": "2026/9/26 00:51:57",
        "timestamp": 1790355117
      },
      {
        "description": "客户已提交退货/退款申请",
        "trans_time": "2026/9/26 00:51:56",
        "timestamp": 1790355116,
        "detail": "商品与描述不符",
        "elements": [
          {
            "title": "其他信息",
            "content": "Đồ đểu shop làm ăn tráo trở ...",
            "media_items": [
              {
                "picture": {
                  "height": 200,
                  "width": 200,
                  "uri": "tos-alisg-i-aphluv4xwc-sg/efcdcb8e3b394d7a85444431c36f7f2e",
                  "url_list": [
                    "https://p16-oec-sg.ibyteimg.com/...~tplv-aphluv4xwc-origin-jpeg.jpeg?...",
                    "https://p19-oec-sg.ibyteimg.com/...~tplv-aphluv4xwc-origin-jpeg.jpeg?..."
                  ]
                }
              },
              {
                "picture": { /* 第二张图 */ }
              }
            ]
          }
        ]
      },
      {
        "description": "订单已送达并签收",
        "trans_time": "2026/9/25 23:22:11",
        "timestamp": 1790349731
      },
      {
        "description": "订单准备发货",
        "trans_time": "2026/9/21 13:07:18",
        "timestamp": 1789967238
      },
      {
        "description": "客户创建订单",
        "trans_time": "2026/9/21 00:57:27",
        "timestamp": 1789923447
      }
    ]
  }
}
```

### 2.2 关键字段说明

| 字段路径 | 类型 | 说明 |
|---|---|---|
| `data.total_count` | int | 历史记录总条数 |
| `data.order_history[].description` | string | 状态变更描述（中文） |
| `data.order_history[].trans_time` | string | 展示用时间（本地格式） |
| `data.order_history[].timestamp` | int (unix seconds) | 事件发生时间戳 |
| `data.order_history[].detail` | string? | 补充详情（如退货原因） |
| `data.order_history[].elements[]` | array? | 附加元素（退货证据等） |
| `data.order_history[].elements[].title` | string? | 元素标题 |
| `data.order_history[].elements[].content` | string? | 元素内容 |
| `data.order_history[].elements[].media_items[]` | array? | 媒体附件 |
| `data.order_history[].elements[].media_items[].picture.uri` | string? | 图片 URI |
| `data.order_history[].elements[].media_items[].picture.url_list` | string[]? | 图片 URL 列表 |

### 2.3 已知时间线顺序

`order_history` 数组按 **时间倒序**（最新事件在前）：

1. 退款完成
2. 客户已将退货包裹寄送给商家
3. TikTok Shop 自动批准退货
4. 客户提交退货/退款申请
5. 订单已送达并签收
6. 订单准备发货
7. 客户创建订单

---

## 3. 与现有接口的对比

| 接口 | 路径 | Method | 用途 | 现有状态 |
|---|---|---|---|---|
| order/list | `/api/fulfillment/order/list` | POST | 订单列表（分页） | ✅ 已接入 |
| logistic_detail/list | `/api/v1/fulfillment/logistic_detail/list` | GET | 物流详情 | ✅ 已接入 |
| **order/get** | `/api/fulfillment/order/get` | POST | **订单详情（含价格/退货/买家）** | ✅ 本次新增 |
| **order/history** | `/api/v1/fulfillment/order/history` | POST | **订单状态时间线** | ✅ 本次新增 |

## 4. 当前同步链路注意事项

`order/get` 和 `order/history` 都是按订单逐条请求的 N+1 链路，订单 ID 来自 `order/list`，结果通过 `orders` domain 上传，后端再根据 endpoint 路径区分详情和历史。当前实现对请求异常、HTTP 非 2xx、登录失效、业务 `code != 0` 和 schema 校验失败均有处理；只有通过对应 schema 校验的成功 response 才会上传。`order/history` 使用绑定页面的 Seller Center 域名，避免不同 Seller Center 域名下请求来源不一致。
