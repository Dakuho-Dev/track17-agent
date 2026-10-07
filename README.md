# Track17 Agent

App cài trên máy tính, tra trạng thái vận chuyển cho đơn Etsy rồi gửi về WrL
(`wearelucky.io.vn`) để đẩy sang CMS. Hai làn, vì không nguồn nào phủ hết mọi hãng.

## Vì sao cần app này

Etsy chỉ trả về hãng vận chuyển và mã vận đơn, không có trạng thái pre-transit /
in-transit. Trạng thái đó phải hỏi hãng vận chuyển. Hệ thống chia làm hai làn:

| Làn | Nguồn | Bao nhiêu đơn |
|---|---|---|
| **17track** (DHL, Yanwen, YunExpress, UniUni, UPS, OnTrac, SPX…) | Ô tìm kiếm của 17track.net, 40 mã một lượt | ~20% |
| **Etsy** (USPS và phần còn lại) | Trang đơn của người bán, lọc sẵn theo trạng thái vận chuyển | ~80% |

Làn 17track làm đúng việc một người sẽ làm: lấy danh sách mã cần tra, dán vào ô đó,
bấm tra, đọc kết quả, gửi về.

Làn Etsy tồn tại vì USPS đã chặn hết đường tra của bên thứ ba (xem mục dưới). Nhưng
Etsy thì **đã tự tra hãng vận chuyển rồi** — chữ "Pre-transit" trên trang đơn chính
là kết quả đó.

Danh sách đơn trên trang được vẽ từ một lời gọi JSON nội bộ của chính Etsy:

```
/api/v3/ajax/bespoke/shop/<shopId>/mission-control/orders/data
    ?filters[completed_status]=pre_transit&limit=50&offset=0 …
```

Mỗi đơn trong đó mang sẵn nhãn Etsy ở
`fulfillment.status.physical_status.shipping_status.tracking_status.summary`
("Pre-transit", "In transit", "Out for delivery", "Delivered"). App gọi đúng lời gọi
đó **từ bên trong trang Etsy của profile**, nên nó đi ra với cookie, vân tay và proxy
của chính profile, y như trang tự gọi. App gửi về WrL mã đơn + chữ gốc của Etsy
(`statusText`), WrL tự quy đổi. Không tên người mua hay địa chỉ nào ra khỏi trình duyệt.

Đã thử và **không** dùng được (đo trên shop thật 05/10/2026):

- Mở thẳng `/your/orders/sold/all?completed_status=pre_transit`: Etsy đưa về tab xem
  lần trước và bỏ bộ lọc, nên ba "trang trạng thái" ra cùng một trang.
- Nhặt `#` + chữ số trên trang: kể cả khi lọc đúng cũng chỉ thấy 20 dòng đang vẽ.

App đọc ba danh sách cho mỗi shop: `pre_transit`, `in_transit`, `delivered`, mỗi lượt
50 đơn (xin hơn 50 thì Etsy lặng lẽ trả 20). Hai trạng thái đầu là phần đang chạy, chỉ
vài chục đơn mỗi shop nên đọc hết. `delivered` cũng phải đọc,
nếu không đơn giao xong sẽ mắc kẹt ở "Đang vận chuyển" mãi mãi — vì đơn chỉ đơn giản
biến mất khỏi hai danh sách kia chứ không báo gì. Nhưng `delivered` rất lớn (một shop
có hơn 10.000 đơn), nên chỉ đọc đơn gửi trong 90 ngày gần nhất, mới nhất trước.

Chạy thử trên Macievision: 346 đơn trong 36 giây — 47 Pre-transit, 44 In transit,
21 Out for delivery, 234 Delivered.

Mỗi shop được đọc **bên trong profile Hidemyacc của chính shop đó** — đúng profile
sạch (vân tay, proxy, phiên Etsy riêng) mà team vẫn dùng. App không giữ phiên Etsy
nào của riêng nó và **không bao giờ tự gõ mật khẩu**.

### Vì sao agent phải tự mở profile qua Hidemyacc

Đã đo trên máy thật (05/10/2026): profile mở tay từ cửa sổ Hidemyacc chạy Chrome
**không có cổng DevTools** (`--remote-debugging-port`), nên không chương trình nào
bên ngoài điều khiển được. Chỉ profile mở qua API cục bộ
`POST http://127.0.0.1:2268/profiles/start/:id` mới có cổng, và phản hồi trả về
`wsUrl`. Gọi `start` lại cho profile đang chạy (do API mở) thì vô hại — trả lại
đúng `wsUrl` cũ — nên agent cứ hỏi lại mỗi lượt, không phải nhớ cổng.

Mỗi lượt cho một shop: `start` profile → bám vào qua DevTools → mở **một tab
riêng** → đọc ba danh sách trạng thái → đóng tab đó → buông ra. Các tab Sếp đang mở
trong profile không bị đụng tới. Agent không bao giờ tự đóng trình duyệt; nếu bật
"Đóng profile sau khi đọc xong" thì nó nhờ Hidemyacc `stop` — và chỉ với profile
do chính agent mở.

API này chỉ chạy khi **app Hidemyacc đang mở và đã đăng nhập**, và chỉ có từ gói
Team trở lên (không thì Hidemyacc trả 402).

App **không** nói chuyện trực tiếp với CMS. Mọi thứ đi qua WrL, nên dữ liệu vẫn qua đúng
một đường kiểm tra và một hàng đợi.

## Tải CSV Etsy theo giờ

Việc thứ ba, chạy song song với hai làn tra vận đơn. Loại CSV và khung giờ đặt ở trang
**Tải Etsy CSV** trên CMS (ô "Tự tải theo giờ", VD `08:00, 14:30, 20:00`, giờ Việt Nam).
Đến giờ, với mỗi shop đã có profile Hidemyacc, agent:

1. mở profile qua Hidemyacc, mở một tab riêng tới `etsy.com/your/shops/me/download`;
2. chọn loại CSV theo CMS, chọn **tháng và năm hiện tại** (không dùng ô tháng/năm của CMS);
3. bấm nút **Download CSV** của mục Orders;
4. bắt file qua DevTools, lưu vào `<Thư mục lưu CSV>/<shop>/<shop> - <tên file Etsy>.csv`.
   Lượt sau trong cùng tháng ghi đè file cũ — file mới luôn đủ hơn.

Mỗi khung giờ chạy đúng một lần (nhớ cả qua lần khởi động lại); agent tắt suốt một tiếng
sau khung giờ thì bỏ khung đó chứ không chạy bù. Nút **Tải CSV ngay** chạy một lượt bất kể lịch.

Hai việc cùng dùng một profile được nhờ một "pool" đếm người dùng: profile chỉ bị đóng
(khi bật "Đóng profile sau khi đọc xong") lúc không còn việc nào dùng nó, và chỉ khi chính
agent đã mở nó.

Agent tự ghép shop với profile tên **"Wakeup 24/7 - <shop>"** khi shop có nhiều profile.

## Cài đặt trên máy treo 24/7

Tải `Track17-Agent-Setup-<version>.exe` ở
[Releases](https://github.com/Dakuho-Dev/track17-agent/releases/latest) rồi chạy.
Bản cài này là loại một-cú-nhấp: không hỏi gì, cài vào thư mục của người dùng hiện
tại (không cần quyền admin), tạo lối tắt ở Desktop và Start Menu.

Sau khi cài, làm ba việc một lần duy nhất:

1. Điền **Địa chỉ WrL** và **Token**, bấm **Kiểm tra kết nối**.
2. Mở app Hidemyacc (đăng nhập sẵn). Trong agent, mục **Profile Hidemyacc** bấm
   **Tải danh sách**, chọn profile cho từng shop rồi **Lưu**. Shop nào chỉ có một
   profile mang tên shop thì agent tự đoán sẵn; shop có nhiều profile (Backup,
   Phương, Lam…) thì Sếp phải chọn — đọc nhầm profile là âm thầm ra 0 đơn.
   Sau đó bấm **Mở profile các shop**. Profile nào chưa đăng nhập Etsy thì Sếp
   đăng nhập trong chính profile đó, một lần.
3. Bật **Chạy liên tục**. Ô này cũng là công tắc "khởi động cùng Windows": bật thì
   máy bật lên là agent tự chạy lại, tắt thì không.

Từ đó máy không cần ai đăng nhập nữa.

## Tự cập nhật

Agent tự kiểm tra bản mới trên GitHub Releases: lần đầu sau 10 giây kể từ lúc mở,
rồi mỗi 6 tiếng. Thấy bản mới thì tải về ngầm.

Điều đáng chú ý là lúc cài: **không bao giờ cài giữa lượt đang chạy.** Một lượt
17track đang giữ 40 mã theo lease 10 phút của WrL, còn một lượt Etsy mất vài phút
mỗi shop — khởi động lại giữa lúc đó là mất kết quả và để mã treo đến khi hết lease.
Nên bản đã tải về đợi đến khi agent rảnh mới cài, đợi bao lâu cũng được, rồi khởi
động lại và tự chạy tiếp. Mọi bước đều ghi vào `agent.log`.

Bản chạy bằng `npm start` thì không tự cập nhật (không có `app-update.yml`), và app
nói rõ điều đó trong log.

## Phát hành bản mới

```bash
npm version patch
git push --follow-tags
```

Tag `v*` kích hoạt [workflow](.github/workflows/release.yml): GitHub Actions build
trên `windows-latest` rồi publish thẳng thành một Release thật. Không dùng draft —
`electron-updater` không thấy được draft, mà máy treo 24/7 thì không có ai vào bấm
publish. Cái tag chính là chốt kiểm duyệt.

Muốn build thử dưới máy mà không publish:

```bash
npm run dist
```

File nằm trong `dist/`.

## Cấu hình

Điền trong cửa sổ app, lưu vào `%APPDATA%/track17-agent/config.json`:

| Ô | Ý nghĩa |
|---|---|
| Địa chỉ WrL | `https://wearelucky.io.vn` |
| Token | Đúng bằng `MANUAL_TRACKING_TOKEN` đặt trên Vercel của WrL |
| Làn nào chạy | Cả hai (17track trước rồi Etsy), hoặc chỉ một làn |
| Số mã mỗi lượt | Tối đa 40 — giới hạn của ô tìm kiếm 17track |
| Số lượt đọc mỗi trạng thái | Mặc định 5 lượt × 50 đơn **cho mỗi trạng thái**. Thiếu thì log báo còn bao nhiêu đơn chưa đọc |
| Nghỉ giữa hai lượt | Mặc định 25 giây |
| Chạy liên tục | Bật thì app tự làm hết hàng đợi rồi nghỉ theo chu kỳ, **và tự chạy lại mỗi lần Windows khởi động**; tắt thì mỗi lần bấm chỉ tra một lượt |
| Hiện cửa sổ 17track | Tắt đi thì cửa sổ vẫn chạy nhưng ẩn |
| Địa chỉ API Hidemyacc | Mặc định `http://127.0.0.1:2268` |
| Profile cho từng shop | Lưu thành `hmaProfiles` = `{ tên shop: id profile }` |
| Đóng profile sau khi đọc xong | Mặc định tắt. Chỉ đóng profile do agent tự mở |

Bấm **Kiểm tra kết nối** để xem token đúng chưa và mỗi làn còn bao nhiêu việc.
Bấm **Mở profile các shop** để agent mở profile Hidemyacc của mọi shop qua API —
**đừng mở tay trong Hidemyacc**, profile mở tay agent không điều khiển được.

## Luồng chạy

Làn 17track:

```
WrL  GET /api/tracking/manual/pending?limit=40
        → 40 mã không phải USPS, đã được giữ chỗ 10 phút
App  mở 17track.net → dán 40 mã (mỗi mã 1 dòng) → bấm TRACK → đọc kết quả
WrL  POST /api/tracking/manual/results   → ghi trạng thái, xoá dấu cmsPushedAt
```

Làn Etsy (chạy sau khi hàng đợi 17track đã hết):

```
WrL  GET /api/tracking/etsy/plan
        → shop nào còn vận đơn chờ, mỗi shop bao nhiêu
App  với mỗi shop: Hidemyacc start profile → tab riêng ở /your/orders/sold
        → gọi orders/data cho pre_transit, in_transit, delivered (90 ngày)
        → mỗi đơn: { orderId, statusText: "Pre-transit" | "In transit" | … }
WrL  POST /api/tracking/etsy/results     → khớp theo số đơn, ghi trạng thái
```

Cuối cùng, lượt đồng bộ kế tiếp của WrL đẩy các đơn đã đổi trạng thái sang CMS.

**Hai làn không tranh nhau:** làn Etsy bỏ qua vận đơn mà làn 17track đã có trạng
thái thật, vì Etsy chỉ cho một nhãn tổng còn 17track cho cả hành trình.

Mã nào app lấy về mà không tra xong thì WrL tự thả sau 10 phút, không cần dọn dẹp gì.
Mã nào đã tra rồi thì mặc định 6 tiếng sau mới tra lại (`MANUAL_RECHECK_HOURS`).

## Đọc kết quả bằng cách nào

Trang 17track vẽ kết quả từ một lời gọi nội bộ của chính nó. App bám vào đó qua kênh
DevTools của cửa sổ và chép lại đúng phản hồi ấy — bền hơn nhiều so với dò tên class CSS,
vốn đổi mỗi lần trang được thiết kế lại.

Nếu không bắt được phản hồi nào, app quay sang đọc chữ hiển thị trên trang. Nhật ký ghi rõ
đã dùng đường nào (`api` hay `scrape`), nên khi 17track đổi giao diện sẽ thấy ngay.

## Đã kiểm chứng trên trang thật (28/09/2026)

Ba chỗ dễ vỡ nhất của app đã được chạy thử trực tiếp trên 17track.net, và đều đã
sửa theo đúng những gì trang trả về:

- Trang có **hai** thẻ `textarea` nhưng chỉ một cái hiện trên màn hình — lấy cái
  đầu tiên là lấy sai. App chọn theo kích thước thực tế.
- Nút gửi là một thẻ `span` chữ **TRACK**, không phải `button`, và nhãn tự thêm số
  đếm khi đã nhập (`Track(2)`).
- Máy lần đầu vào trang gặp một hộp hướng dẫn "Welcome!" chặn cú bấm — app tự tắt.
- Kết quả về từ `POST https://t.17track.net/track/restapi`, thân phản hồi dạng
  `{ shipments: [ { number, pre_status, shipment: { latest_status, latest_event } } ] }`.
  Trang trả lời hai lần mỗi lượt: lần đầu chỉ đăng ký (`code: 100`, chưa có dữ
  liệu), lần sau mới là dữ liệu (`code: 200`).

Thử với 3 mã DHL thật: cả 3 trả về `Delivered` kèm ngày và địa điểm.

## Riêng đơn USPS thì không được

Đã thử tất cả các đường miễn phí bằng mã USPS thật, **không đường nào còn mở**:

| Đường | Kết quả |
|---|---|
| Trang web 17track.net | `Not found` + *"Access Restricted — USPS policy change, please upgrade your account"* |
| parcelsapp.com | *"No information about your package."* |
| tools.usps.com/tracking/ | Akamai Bot Manager — trình duyệt tự động chỉ nhận trang trắng, không có ô nhập nào để dán |

USPS đã cắt nguồn của các trang tra cứu trung gian, còn trang của chính USPS thì
chặn tự động hoá. Vì vậy đơn USPS đi qua **làn Etsy** — nguồn duy nhất còn mở mà
không phải trả tiền, và cũng là nguồn chính xác nhất vì đó là chữ Etsy hiển thị.

Nếu sau này lấy được khoá ở `developer.usps.com` thì chỉ cần điền
`USPS_CLIENT_ID` / `USPS_CLIENT_SECRET` trên WrL: code gọi API USPS đã viết sẵn,
làn USPS quay về máy chủ chạy 24/7 và làn Etsy thành dự phòng.

## Giới hạn cần biết

- App phải có người mở máy; nó không chạy 24/7 như một job trên máy chủ.
- Tra quá dồn dập thì 17track có thể chặn tạm. Giữ khoảng nghỉ mặc định 25 giây.
- Việc tự động thao tác trên 17track.net và trên trang seller của Etsy nằm ngoài điều
  khoản sử dụng của hai bên. Dùng ở mức vừa phải — giữ khoảng nghỉ mặc định, đừng đọc
  quá nhiều trang mỗi lượt.
- Làn Etsy đọc tối đa 5 × 50 đơn cho mỗi trạng thái (chỉnh được). `delivered` chỉ
  tính đơn gửi trong 90 ngày.
- Làn Etsy dựa vào lời gọi JSON nội bộ của Etsy, không phải API công khai — Etsy đổi
  là phải sửa. Khi đó nhật ký ghi rõ `đọc lỗi ở vị trí … — HTTP …` hoặc
  `thiếu orders_search.orders`.
