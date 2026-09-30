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
Etsy thì **đã tự tra hãng vận chuyển rồi**, và quan trọng hơn: nó cho lọc theo trạng
thái ngay trên URL —

```
etsy.com/your/orders/sold/all?completed_status=pre_transit
```

Nên **trang chính là bộ lọc**: mọi đơn hiện ra đều chắc chắn ở đúng trạng thái đó, và
app chỉ cần nhặt mã đơn. Không phải đọc nhãn trong từng dòng, không phụ thuộc tên class
— Etsy đổi giao diện thì `#` + chữ số vẫn là mã đơn.

App đi qua ba trang cho mỗi shop: `pre_transit`, `in_transit`, `delivered`. Hai trạng
thái đầu là phần đang chạy, cần theo dõi liên tục. Trang `delivered` cũng phải quét,
nếu không đơn giao xong sẽ mắc kẹt ở "Đang vận chuyển" mãi mãi — vì đơn chỉ đơn giản
biến mất khỏi hai danh sách kia chứ không báo gì.

Mỗi shop một phiên đăng nhập riêng. **App không bao giờ tự gõ mật khẩu** — Sếp tự
đăng nhập một lần cho mỗi shop, sau đó phiên được giữ lại.

App **không** nói chuyện trực tiếp với CMS. Mọi thứ đi qua WrL, nên dữ liệu vẫn qua đúng
một đường kiểm tra và một hàng đợi.

## Cài đặt trên máy treo 24/7

Tải `Track17-Agent-Setup-<version>.exe` ở
[Releases](https://github.com/Dakuho-Dev/track17-agent/releases/latest) rồi chạy.
Bản cài này là loại một-cú-nhấp: không hỏi gì, cài vào thư mục của người dùng hiện
tại (không cần quyền admin), tạo lối tắt ở Desktop và Start Menu.

Sau khi cài, làm ba việc một lần duy nhất:

1. Điền **Địa chỉ WrL** và **Token**, bấm **Kiểm tra kết nối**.
2. Bấm **Đăng nhập Etsy** rồi đăng nhập từng cửa sổ shop. App không bao giờ tự
   điền mật khẩu — phiên đăng nhập được giữ lại nên chỉ phải làm một lần cho mỗi shop.
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
| Số trang đơn đọc mỗi shop | Mặc định 5 trang **cho mỗi trạng thái**, tính từ trang mới nhất |
| Nghỉ giữa hai lượt | Mặc định 25 giây |
| Chạy liên tục | Bật thì app tự làm hết hàng đợi rồi nghỉ theo chu kỳ, **và tự chạy lại mỗi lần Windows khởi động**; tắt thì mỗi lần bấm chỉ tra một lượt |
| Hiện cửa sổ 17track | Tắt đi thì cửa sổ vẫn chạy nhưng ẩn |

Bấm **Kiểm tra kết nối** để xem token đúng chưa và mỗi làn còn bao nhiêu việc.
Bấm **Đăng nhập Etsy** để app mở sẵn một cửa sổ cho từng shop — Sếp đăng nhập từng
cái một, chỉ cần làm một lần.

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
App  với mỗi shop, lần lượt mở ba trang đã lọc sẵn:
        ?completed_status=pre_transit   → mọi mã đơn ở đây = PRE_TRANSIT
        ?completed_status=in_transit    → = IN_TRANSIT
        ?completed_status=delivered     → = DELIVERED
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
- Làn Etsy chỉ đọc các trang đơn gần đây (mặc định 5 trang mỗi shop). Đơn cũ hơn thế thì
  phải tăng số trang lên.
- Làn Etsy không dò tên class nào cả — trạng thái đến từ URL, mã đơn đến từ mẫu
  `#` + tối thiểu 6 chữ số. Nếu Etsy đổi trang tới mức không còn mã đơn nào, nhật ký
  phân biệt rõ hai trường hợp: trang báo rỗng (bình thường) và trang không báo gì mà
  cũng không có mã đơn (đáng ngờ, kèm số ký tự đọc được).
