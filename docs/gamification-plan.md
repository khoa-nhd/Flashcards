# Kế hoạch game hóa

Tài liệu này ghi mọi quyết định đã chốt với chủ dự án (buổi hỏi đáp ngày
2026-10-29) và chia việc thành 5 giai đoạn. Mỗi giai đoạn deploy và dùng được
riêng; giai đoạn sau chỉ dựa vào giai đoạn trước.

| Giai đoạn | Nội dung | Schema | Cỡ việc |
|---|---|---|---|
| 1 | Cá nhân: XP, level, nhiệm vụ, huy hiệu, đóng băng streak, điểm danh, ôn sớm, ôn ngẫu nhiên, màn nhận thưởng | v17 | L |
| 2 | Cạnh tranh: khóa quyền ghi, biệt danh, giải đấu tuần + bot, bạn bè, hồ sơ, quản trị | v18 | XL |
| 3 | Kinh tế và sưu tầm: bụi sao, cửa hàng, rương, linh vật, thẻ chòm sao, boss, sự kiện | v19 | XL |
| 4 | Nhắc nhở: web push | v20 | M |
| 5 | PvP: đấu xếp hạng, đấu với bạn | v21 | XL |

---

## 0. Nguyên tắc chung (áp dụng mọi giai đoạn)

1. **Game hóa không bao giờ đổi lịch FSRS.** Nó chỉ đọc kết quả học. Ngoại lệ
   duy nhất là chế độ "Ôn sớm", vì đó là lượt ôn thật và đi qua đúng đường ôn
   hiện có.
2. **XP do database tính, trình duyệt không gửi XP lên.** XP sinh ra từ các
   lượt ôn/luyện tập đã lưu (trigger trên `review_logs`), nên không có API nào
   nhận "cộng cho tôi X XP".
3. **Nhớ và Quên cho cùng XP.** Không có gì trong game thưởng cho việc bấm Nhớ
   (kể cả combo), để không ai khai sai làm hỏng lịch ôn.
4. **Phần thưởng cộng, không nhân.** Mọi hệ số (combo, giờ vàng, Chủ nhật,
   quay lại, vật phẩm x2, linh vật) cộng phần trăm lại rồi nhân một lần với XP
   gốc.
5. **Mỗi tài khoản chỉ thấy dữ liệu của mình**, trừ những gì công khai có chủ ý
   (biệt danh, level, hạng, huy hiệu, streak; ở PvP là các từ trong trận). Dữ
   liệu giữa các tài khoản chỉ đi qua hàm `security definer` trả về đúng các
   cột công khai. Không dùng service-role key ở đâu cả.
6. **Mỗi giai đoạn một file SQL mới**, gắn với một số phiên bản schema
   (`app_schema_version`), chỉ thêm, chạy lại được. Không sửa file migration đã
   chạy trên production. Mỗi file có test nâng cấp từ database thật trước nó
   (xem `tests/database/schema-v16-upgrade.test.ts`). Code đọc phiên bản để tự
   tắt tính năng khi database chưa cập nhật.
7. **Song ngữ EN/VI, giảm chuyển động, phím tắt không lọt**, theo cách các cảnh
   Moonrise/Moonset đang làm.
8. **Phong cách**: tông đêm/ánh trăng của app nhưng nhãn dễ hiểu (XP, Level 12,
   Hạng Vàng, Bụi sao), không đặt tên bí ẩn.
9. **Mỗi giai đoạn có bản mẫu** trong `npm run dev:mock-fsrs` (mock repository)
   để kiểm tra bằng click thật, không đụng dữ liệu thật.

### Quyết định mặc định tôi tự đặt (cần chủ dự án duyệt)

Những điểm buổi hỏi đáp chưa nói tới; tôi chọn như sau, sửa được trước khi làm:

| Điểm | Mặc định |
|---|---|
| Undo một câu trả lời | XP của câu đó bị trừ lại (bút toán âm), combo không đổi |
| Xóa/lưu trữ từ đã có XP | XP đã nhận giữ nguyên |
| Múi giờ giờ vàng, nhiệm vụ, điểm danh | Múi giờ của tài khoản (`user_settings.time_zone`) |
| Múi giờ giải đấu | Asia/Ho_Chi_Minh cho tất cả (đã chốt) |
| Đóng băng streak | Mỗi cái che đúng 1 ngày lỡ; giữ 2 cái thì che được 2 ngày liền |
| Quản trị | Biến `ADMIN_EMAILS` mở trang quản trị; database còn có bảng `app_admins` (chủ dự án tự thêm user id bằng SQL) vì hàm SQL không đọc được biến môi trường và ta không dùng service-role key |
| Bot rời nhóm | Người thật vào nhóm đã đủ 20 thì bot ít XP nhất "rời nhóm" |

---

## Giai đoạn 1 – Cá nhân (schema v17)

**Mục tiêu:** mỗi lượt học đều có XP, level, nhiệm vụ; streak được bảo vệ;
có hai chế độ ôn thêm; mỗi lần vào Dashboard nhận các phần thưởng đang chờ.
Chưa có gì công khai.

### 1.1 Luật XP

| Hoạt động | XP gốc | Nhận diện trong `review_logs` |
|---|---|---|
| Ôn đúng hạn (Nhớ hay Quên) | 10 | `kind='review'`, tính vào lịch, từ đã đến hạn lúc trả lời |
| Học từ mới lần đầu | 15 + 2 (thưởng thêm từ) | `counted_as_new = true` |
| Ôn sớm | 5 | `kind='review'`, tính vào lịch, từ chưa đến hạn |
| Ôn ngẫu nhiên / ôn không tính lịch | 5 | `kind='review'`, `counted_toward_schedule = false` |
| Luyện tập (mọi chế độ) | 5 | `kind='practice'` |
| Đạt đủ mục tiêu ngày | +50 | `study_days.met` chuyển false → true |
| Nhiệm vụ ngày | 20–40 mỗi cái, đủ 3 thêm 50 | bảng nhiệm vụ |
| Nhiệm vụ tuần | 300 | bảng nhiệm vụ |
| Điểm danh ngày 1→7 | 10, 15, 20, 25, 30, 40, 100 | bảng điểm danh |

- **Thêm từ:** XP 2 cho việc thêm từ chỉ trả ở lượt học đầu tiên của từ đó (gộp
  vào dòng "học từ mới"), nên spam từ rác không được gì nếu không ôn. Không giới
  hạn số từ.
- **Combo:** đếm mọi câu trả lời liên tiếp (ôn và luyện tập, cả Quên). Khoảng
  cách giữa hai câu quá 2 phút thì về 0. Từ câu 10: +10%, từ 25: +25%, từ 50:
  +50%.
- **Quay lại:** nghỉ từ 3 ngày (không có lượt học nào) thì 24 giờ kể từ lượt
  đầu tiên quay lại được +100%.
- **Công thức một câu:** `round(gốc × (1 + combo + quay lại + …))`. Giai đoạn 3
  thêm giờ vàng, Chủ nhật, vật phẩm x2, linh vật vào cùng tổng phần trăm.
- **Undo:** trừ đúng số XP câu đó đã nhận.

### 1.2 Level

- XP cần để lên level `n+1`: `round(100 × 1.15^(n-1))`. Level 2 cần 100,
  level 10 tổng khoảng 1.700 (khoảng 4 ngày học đều: 30 lượt ôn, mục tiêu và
  nhiệm vụ, chừng 400 XP/ngày), level 20 khoảng 8.800 (khoảng 3 tuần). Không có
  level tối đa.
- Hàm trong `shared/gamification/levels.ts` (thuần, có test): `levelOf(xp)`,
  `xpForLevel(n)`, `progress(xp)`.

### 1.3 Nhiệm vụ

- **Ngày:** mỗi ngày (theo múi giờ tài khoản) rút ngẫu nhiên 3 nhiệm vụ không
  trùng loại từ danh sách. Con số theo mục tiêu ngày của người đó. Danh sách ban đầu:
  ôn N lượt đúng hạn · học N từ mới · luyện tập N lượt · ôn N từ yếu (Weakest
  words) · luyện nghe N câu · thêm N từ · giữ combo N · học N phút · đạt mục
  tiêu trước 12h trưa.
- **Tuần:** 1 nhiệm vụ lớn mỗi tuần (thứ Hai→Chủ nhật): đưa N từ lên Master ·
  đạt mục tiêu 5/7 ngày · 300 lượt ôn · 10 từ yếu được sửa.
- **Dài hạn = huy hiệu nhiều bậc** (mục 1.4).
- Tiến độ cập nhật trong database cùng lúc với XP (trigger), không cần trình
  duyệt báo.

### 1.4 Huy hiệu (thành tựu dài hạn)

Danh mục nằm trong code (`shared/gamification/badges.ts`), mỗi huy hiệu có các
bậc (Đồng/Bạc/Vàng/Kim cương). Ban đầu:

| Huy hiệu | Bậc |
|---|---|
| Kho từ (số từ đã học) | 50 · 100 · 500 · 1.000 · 5.000 |
| Bậc thầy (số từ Master) | 10 · 50 · 200 · 1.000 |
| Chăm ôn (lượt ôn) | 100 · 1.000 · 10.000 · 50.000 |
| Luyện công (lượt luyện tập) | 100 · 1.000 · 5.000 |
| Bền bỉ (streak dài nhất) | 7 · 30 · 100 · 365 |
| Giờ học (tổng thời gian trả lời) | 1h · 10h · 100h · 500h |
| Thợ sửa (từ yếu đã hồi phục) | 10 · 100 · 500 |
| Cú đêm (học sau 23h) | 10 · 50 lần |
| Combo (combo cao nhất) | 25 · 50 · 100 · 250 |

Huy hiệu được tính lại từ số liệu thật sau mỗi lần cập nhật XP, nên người dùng
cũ nhận ngay các bậc đã đủ.

### 1.5 Đóng băng streak

- Cứ mỗi mốc 7 ngày streak (7, 14, 21…) được tặng 1, giữ tối đa 2.
- Ngày bị lỡ (không đạt mục tiêu) mà còn đóng băng thì tự dùng 1 cái, ghi lại
  ngày dùng; streak coi ngày đó như đã giữ (không cộng thêm 1).
- Nối vào `StudyGoalsService.progress` / `streakOf`: danh sách ngày được che
  đóng băng cùng tính như ngày đạt. Việc tiêu đóng băng làm khi lần đầu đọc
  mục tiêu sau ngày bị lỡ, trong một transaction, không làm hai lần.
- Cảnh Moonset (streak kết thúc) không hiện nếu đóng băng đã che; thay bằng
  thông báo nhỏ "Đã dùng 1 đóng băng để giữ chuỗi".

### 1.6 Điểm danh 7 ngày và quà quay lại

- Ngày nào có ít nhất 1 lượt học là đã điểm danh. Quà tăng từ ngày 1 đến
  ngày 7 (bảng 1.1); lỡ một ngày thì vòng quay về ngày 1. Giai đoạn 3 đổi quà
  ngày 7 thành rương hiếm.
- Quay lại sau ≥ 3 ngày nghỉ: +100% XP trong 24 giờ (mục 1.1).

### 1.7 Hai chế độ ôn mới

- **Ôn sớm:** các từ sẽ đến hạn trong N ngày tới (người dùng chọn 1–14, mặc
  định 3, nhớ theo tài khoản), gần hạn nhất trước. **Tính vào lịch FSRS**, đi
  đúng đường `review-action` hiện có với `allowNotDue`.
- **Ôn ngẫu nhiên:** từ bất kỳ đã học (không lưu trữ), trộn ngẫu nhiên. **Không
  đổi lịch**: dùng cơ chế "Count toward schedule" tắt sẵn có, như Weakest
  words.
- Thêm hai lựa chọn vào thanh chọn chế độ ở trang Review (cạnh Everything due /
  Weakest words / Select words), và nút "Ôn thêm" ở Dashboard khi đã hết từ
  đến hạn.
- Server: thêm hai `focus` cho `/api/review-queue` (`early` với số ngày,
  `random` với số từ), trả về đúng như các focus khác.

### 1.8 Màn nhận thưởng

- Bảng phần thưởng đang chờ: level lên, huy hiệu mới, nhiệm vụ xong, đóng băng
  được tặng, quà điểm danh.
- **Mỗi lần vào Dashboard**, nếu có phần thưởng chưa nhận thì mở một chuỗi cảnh
  toàn màn hình (dùng `NightScene` của Moonrise), mỗi thứ một cảnh, có nút
  "Nhận" và "Nhận tất cả". Moonrise (đạt mục tiêu ngày) vẫn hiện ngay lúc đạt
  như hiện nay.
- Nhận thưởng là gọi API, server đánh dấu đã nhận; nhận lại lần nữa không có
  tác dụng.

### 1.9 Dữ liệu (file `20261030090000_gamification_core.sql`, schema v17) — đã làm

**Cách làm thực tế (thay cho trigger dự tính ban đầu):** luật chơi chỉ viết một
lần, bằng TypeScript (`shared/gamification/engine.ts`), dùng chung cho server,
bản mẫu và test. Server đọc các câu trả lời chưa tính, chạy engine, rồi ghi kết
quả qua **một hàm duy nhất `game_commit`**, hàm này chỉ nhận thay đổi có chữ
ký HMAC-SHA256 bằng khóa bí mật mà server (`GAME_SIGNING_KEY`) và database
(`game_signing_key`) cùng giữ. Người dùng có khóa public cũng không ghi XP được.
Không cần bước backfill riêng: lần đọc đầu tiên tự tính toàn bộ lịch sử (theo
lô 2.000 câu), và một câu trả lời mà bước game lỗi sẽ được bù ở lần đọc sau.

| Bảng / hàm | Vai trò |
|---|---|
| `xp_ledger` (user_id, source, source_id, amount, base, bonus, reason, earned_at, earned_on) — khóa (user_id, source, source_id) | Sổ XP; undo là dòng âm; không thể tính một câu hai lần |
| `game_state` (user_id, version, total_xp, state jsonb) | Trạng thái engine; `version` chặn hai thay đổi từ cùng một bản đọc (và chặn dùng lại một thay đổi đã ký) |
| `game_quests`, `game_badges`, `game_freezes`, `game_rewards` | Nhiệm vụ, huy hiệu, đóng băng, phần thưởng chờ nhận |
| `game_signing_key` | Khóa ký; không ai đọc được ngoài `game_commit` |
| `game_pending_answers(limit)` | Câu trả lời chưa có trong sổ, đã phân loại mới / đúng hạn / tính lịch như `study_day_counts` |
| `game_badge_metrics()` | Các tổng mà huy hiệu đọc |
| `game_hmac`, `game_commit(payload, signature)` | Kiểm chữ ký rồi ghi |

RLS: mỗi người chỉ đọc dòng của mình; **không cấp insert/update/delete** cho
`authenticated` trên các bảng game.

Khác biệt nhỏ so với kế hoạch: huy hiệu "Thợ sửa" (từ yếu hồi phục) chưa làm ở
giai đoạn 1; nhiệm vụ "ôn N từ yếu" được thay bằng "ôn thêm N từ (sớm hoặc ngẫu
nhiên)" vì lịch sử không ghi lượt ôn đến từ chế độ nào.

### 1.10 Server và giao diện

- `server/game-service.ts`: đọc trạng thái (XP, level, nhiệm vụ, huy hiệu, đóng
  băng, điểm danh, phần thưởng chờ). Route: `GET /api/game`,
  `POST /api/game/rewards/:id/claim`, `POST /api/game/rewards/claim-all`,
  `PUT /api/game/settings` (số ngày ôn sớm).
- `shared/api.ts`: schema Zod cho các phản hồi trên.
- Giao diện:
  - Thanh XP/level nhỏ trên đầu trang (AppShell), số XP bay lên khi mỗi câu
    được lưu (đọc từ phản hồi `review-action`, server trả kèm XP vừa nhận).
  - Thẻ "Nhiệm vụ hôm nay" trên Dashboard cạnh mục tiêu ngày.
  - Trang **Thành tích** mới: level, huy hiệu (đạt/chưa, bậc tiếp theo), lịch
    điểm danh, đóng băng đang giữ.
  - Chỉ số combo trong buổi ôn (x1.1 / x1.25 / x1.5).
  - Màn nhận thưởng (1.8).
- Help: thêm mục XP, level, đóng băng, ôn sớm/ngẫu nhiên.
- Mock repository: sổ XP trong bộ nhớ, cùng luật, để `dev:mock-fsrs` chạy đủ.

### 1.11 Test

- Thuần: luật XP (gốc, cộng phần trăm, combo, quay lại), level, chọn nhiệm vụ
  ổn định theo seed, huy hiệu.
- Database (PGlite): trigger cấp đúng XP cho từng loại `review_logs`; undo trừ
  lại; unique key chặn cộng trùng; người A không đọc/ghi được dữ liệu game của B;
  `authenticated` không ghi thẳng được vào bảng game; backfill chạy hai lần vẫn
  đúng; **nâng cấp từ database v16 có dữ liệu**.
- API: `GET /api/game`, nhận thưởng một lần, ôn sớm tính lịch, ôn ngẫu nhiên
  không đổi lịch.
- Giao diện: XP bay lên sau câu trả lời, màn nhận thưởng ở Dashboard, phím
  không lọt khi cảnh đang mở; click thật trên `dev:mock-fsrs`.

### 1.12 Chủ dự án làm

1. Tạo một khóa: `openssl rand -hex 32` (hoặc 64 ký tự hex bất kỳ).
2. Supabase → SQL Editor: chạy `supabase/migrations/20261030090000_gamification_core.sql`,
   rồi lưu khóa:
   `insert into public.game_signing_key (key) values ('<khóa>') on conflict (id) do update set key = excluded.key;`
3. Vercel → Environment Variables: `GAME_SIGNING_KEY=<cùng khóa đó>`, rồi Redeploy.
4. Mở Dashboard: lịch sử cũ được quy đổi thành XP ở lần mở đầu tiên.

---

## Giai đoạn 2 – Cạnh tranh (schema v18)

**Mục tiêu:** người lạ đăng ký được, có biệt danh, thi giải đấu tuần, theo dõi
bạn bè, có hồ sơ công khai, và chủ dự án quản lý được nội dung xấu.

### 2.0 Khóa quyền ghi (làm trước tiên, bắt buộc)

Hiện người dùng đăng nhập được `insert` thẳng vào `review_logs` (và ghi
`card_states`) bằng khóa public của Supabase. Khi XP lên bảng công khai, đó là
lỗ gian lận: tự chèn lượt ôn giả để lấy XP.

- Thu hồi `insert/update/delete` của `authenticated` trên `review_logs`,
  `card_states` và các bảng game; mọi ghi đi qua các hàm hiện có
  (`record_fsrs_review`, luyện tập, undo…) chuyển thành `security definer`, kiểm
  tra `auth.uid()` sở hữu từ, và giữ nguyên luật FSRS (không đổi thuật toán).
- **Giới hạn hợp lý** trong hàm ghi: tối thiểu 600 ms giữa hai câu trả lời của
  một người, tối đa 90 câu/phút; câu vượt giới hạn vẫn lưu cho việc học nhưng
  không có XP (`xp_ledger.amount = 0`, lý do ghi lại).
- Test: gọi thẳng PostgREST bằng JWT người dùng để chèn `review_logs` thì bị từ
  chối; luồng ôn/luyện tập/undo qua app vẫn chạy y nguyên (toàn bộ test hiện có).

### 2.1 Biệt danh

- Bảng `public_profiles` (user_id pk, nickname citext unique, frame, title,
  in_leagues bool default true, hidden_by_admin bool, created_at).
- Tài khoản mới được tên ngẫu nhiên kiểu "Cú Đêm 4821"; đổi tên trong Settings.
- Luật: 3–20 ký tự, chữ/số/khoảng trắng/`_`, không trùng (không phân biệt hoa
  thường), không chứa từ trong danh sách từ bậy Anh/Việt
  (`shared/gamification/blocklist.ts`, so sánh sau khi bỏ dấu và ký tự lặp).
- Tắt "tham gia giải đấu" trong Settings thì không vào nhóm mới (tuần đang chạy
  vẫn giữ chỗ).

### 2.2 Giải đấu tuần

- 8 hạng: Đồng → Bạc → Vàng → Bạch kim → Ngọc → Kim cương → Trăng → Sao.
- Tuần chạy từ 0h thứ Hai đến hết Chủ nhật giờ Việt Nam. Điểm = tổng
  `xp_ledger` trong tuần (kể cả thưởng).
- Người dùng vào nhóm ở lần đầu có XP trong tuần: nhóm đang mở của hạng mình
  (dưới 20 người thật, tạo trong 24 giờ gần đây), không thì tạo nhóm mới.
- Cuối tuần: top 5 lên hạng, 5 cuối xuống hạng (Đồng không xuống, Sao không
  lên). Người 0 XP cả tuần không vào nhóm và không đổi hạng.
- **Chốt tuần không cần hẹn giờ:** request đầu tiên sau khi tuần kết thúc chốt
  kết quả mọi nhóm của tuần đó trong một transaction (chạy lại không đổi gì),
  ghi phần thưởng chờ (huy hiệu hạng, lên/xuống hạng).
- Bảng: `league_weeks`, `league_groups` (id, week_start, tier),
  `league_members` (group_id, member_id, is_bot, xp_week, final_rank),
  `league_tiers` (user_id, tier).
- Giao diện: trang **Giải đấu** — bảng 20 người với biệt danh, khung, XP tuần,
  vùng lên/xuống hạng tô màu, đếm ngược tới hết tuần; thẻ nhỏ trên Dashboard
  "Bạn đang hạng 7 · còn 120 XP để vào vùng lên hạng".

### 2.3 Bot (giấu kín, đã chốt)

- Mỗi nhóm luôn đủ 20 chỗ; chỗ trống là bot. Người thật vào nhóm đã đủ 20 thì
  bot ít XP nhất rời nhóm.
- Bot có biệt danh sinh theo cùng kiểu người thật, khung/danh hiệu theo hạng,
  và **một tính cách**: lười (ít học, hay ở vùng xuống hạng), đều đặn, bùng nổ
  cuối tuần, cày cực nhiều (hiếm). Hạng càng cao, mức XP của mỗi tính cách càng
  lớn (lấy theo phân bố XP thật của hạng đó khi đã có dữ liệu, trước đó theo
  bảng mặc định).
- XP bot tính tất định từ (seed của bot, thời điểm hiện tại): đường cong học
  trong ngày theo giờ, có ngày nghỉ, nên lần nào xem cũng khớp và tăng dần như
  người thật. Không chạy tiến trình nền.
- Bot không có hồ sơ mở được: bấm vào bot hiện hồ sơ rút gọn sinh từ seed
  (level, hạng, vài huy hiệu) để không lộ.
- Help ghi một dòng: "Khi chưa đủ người, giải đấu có thêm đối thủ mô phỏng."
- Bot dùng lại cho PvP (giai đoạn 5).

### 2.4 Bạn bè

- Theo dõi một chiều (`follows` follower→followee); tìm theo biệt danh hoặc
  link mời (`invites` có token, hết hạn 30 ngày).
- Hai người theo dõi nhau = bạn bè: thấy level, streak, XP tuần của nhau; có
  **streak chung** (số ngày liên tiếp cả hai cùng đạt mục tiêu, tính từ
  `study_days` qua hàm definer chỉ trả ngày đạt); **thách đấu tuần 1-1**
  (`challenges`: ai nhiều XP tuần hơn thắng, thưởng XP).
- Bảng xếp hạng bạn bè theo XP tuần.
- Chặn/bỏ theo dõi; người bị chặn không tìm thấy mình.

### 2.5 Hồ sơ công khai

- Trang `/u/:nickname`: biệt danh, khung, danh hiệu, level, hạng giải đấu,
  streak, huy hiệu, số từ Master. **Không có danh sách từ.**
- Nút "Tạo ảnh thành tích": vẽ ảnh bằng canvas ngay trên trình duyệt, tải về
  hoặc chia sẻ (Web Share API nếu có).
- Nút báo cáo biệt danh/hồ sơ.

### 2.6 Quản trị

- Trang `/admin` chỉ hiện với email trong `ADMIN_EMAILS` (server kiểm tra, không
  tin trình duyệt) và user id có trong bảng `app_admins`.
- Xem báo cáo, đổi biệt danh vi phạm về tên ngẫu nhiên, ẩn hồ sơ khỏi bảng.

### 2.7 Test

- Khóa quyền ghi (2.0) như trên.
- Hàm công khai chỉ trả đúng cột công khai; người A không đọc được email, từ
  vựng, lịch ôn của B.
- Biệt danh: trùng, từ bậy, ký tự lạ.
- Giải đấu: xếp nhóm, chốt tuần đúng một lần, lên/xuống hạng, nhóm nhỏ, người
  0 XP; bot tất định (cùng thời điểm cùng XP), XP bot không giảm theo thời gian.
- Bạn bè: theo dõi, chặn, streak chung, thách đấu.
- Quản trị: người không phải admin bị từ chối ở cả route và hàm SQL.

### 2.8 Chủ dự án làm

1. Supabase → SQL Editor: chạy `supabase/migrations/20261031090000_competition.sql`
   (cần v17 và khóa ký đã đặt; giải đấu ký bằng cùng `GAME_SIGNING_KEY`).
2. Thêm mình làm admin: Authentication → Users, chép User UID của mình, rồi
   `insert into public.app_admins (user_id) values ('<UID>');`
3. Vercel → Environment Variables: `ADMIN_EMAILS=<email của bạn>`, rồi Redeploy.
4. Bật đăng ký công khai trong Supabase Auth nếu đang tắt, và xem lại giới hạn
   email xác nhận.

### 2.9 Đã làm (khác với kế hoạch ở đâu)

- **Khóa quyền ghi** bằng trigger: `review_logs`, `card_states` và `study_days`
  từ chối mọi ghi qua endpoint bảng của API (`request.path` không bắt đầu bằng
  `/rpc/`). Các hàm ghi hiện có giữ nguyên, không đổi luật FSRS. SQL Editor
  (không có request path) vẫn ghi được.
- **Giới hạn** 600 ms giữa hai câu và 90 câu/phút tính theo giờ của database
  (`review_logs.recorded_at`, cột mới). Câu vượt giới hạn vẫn lưu, vẫn đổi lịch,
  chỉ được 0 XP (lý do `capped`) và không tính nhiệm vụ. Lịch sử trước v18 không
  có `recorded_at` nên không bị giới hạn.
- **Mọi ghi** của giai đoạn 2 đi qua một hàm `game_apply` có chữ ký HMAC như
  `game_commit`, hết hạn sau 60 giây. Dữ liệu người khác chỉ đọc qua các hàm
  `security definer` trả cột công khai; trình duyệt chỉ thấy biệt danh.
- **Bot** không lưu: tính từ id nhóm và số ghế (`shared/gamification/league.ts`).
  Bấm vào bot hiện hồ sơ "giữ riêng tư" (level, hạng, vài huy hiệu).
- **Chốt tuần** khi có request đầu tiên sau 0h thứ Hai (giờ Việt Nam); chốt hai
  lần không đổi gì. Phần thưởng `league` không có XP.
- **Thách đấu**: thắng 100 XP, hòa mỗi người 50 (mặc định tôi đặt, cần duyệt).
- Hồ sơ ở `/profile?u=<biệt danh>` vì router chỉ có đường dẫn cố định.
- Bảng `league_weeks` và cột `is_bot` trong kế hoạch không cần nữa.

---

## Giai đoạn 3 – Kinh tế và sưu tầm (schema v19)

### 3.1 Bụi sao

| Nguồn | Bụi sao |
|---|---|
| Lên level | 20 × level mới (tối đa 500) |
| Nhiệm vụ ngày / đủ 3 | 10 mỗi cái / +20 |
| Nhiệm vụ tuần | 150 |
| Rương | xem 3.3 |
| Giải đấu cuối tuần | top 1–3: 200/150/100 · lên hạng: 50 |
| Trùng vật phẩm | đổi theo độ hiếm: 10 / 40 / 150 |

Người học đều mỗi ngày (đạt mục tiêu + 3 nhiệm vụ) được khoảng 70–100/ngày.
Sổ `stardust_ledger` giống sổ XP; số dư không âm. Không bán bằng tiền thật.

### 3.2 Cửa hàng

- Mỗi ngày (múi giờ tài khoản) 4 món ngẫu nhiên theo seed người dùng + ngày,
  đổi lúc 0h, có đồng hồ đếm ngược.
- Luôn bán: đóng băng streak (200), x2 XP 15 phút (150), **sửa streak đã đứt**
  trong 2 ngày (500, tạo đóng băng hồi tố cho các ngày lỡ nếu ≤ 2 ngày).
- Mua qua hàm `security definer` (trừ bụi sao, thêm vật phẩm trong một
  transaction); không mua trùng món đã có.

### 3.3 Rương

- Mỗi ngày đạt mục tiêu được 1 rương (vào phần thưởng chờ, mở ở màn nhận
  thưởng): thường 70% · hiếm 25% · huyền thoại 5%; streak ≥ 30 ngày thì
  hiếm 30% / huyền thoại 7%.
- Nội dung: thường = 30–60 bụi sao hoặc 50 XP; hiếm = 100–200 bụi sao, thẻ chòm
  sao, khung; huyền thoại = 400 bụi sao, linh vật hoặc món hiếm, và có thể ra
  **chìa khóa ô linh vật**.
- Quay số trên server (`gen_random_uuid` làm nguồn ngẫu nhiên trong hàm
  definer), lưu kết quả trước khi trả về; mở lại không quay lại.
- Điểm danh ngày 7 đổi thành rương hiếm.

### 3.4 Vật phẩm sưu tầm

- **Linh vật** (6 con lúc ra mắt: cú đêm, thỏ trăng, cáo sao, mèo mây, cá voi
  đêm, rồng sao nhỏ), mỗi con 4 hình dạng lớn dần và vài bộ trang phục.
- **Thẻ chòm sao:** 88 chòm sao thật, 4 độ hiếm; bộ sưu tập (12 cung hoàng đạo,
  chòm sao Bắc, Nam…) đủ bộ thì có thưởng.
- **Giao diện, khung đại diện, hiệu ứng** (lật thẻ, kiểu cảnh Moonrise).
- **Danh hiệu** dưới biệt danh: có cái mua, có cái chỉ đạt bằng thành tích.
- Không trao đổi giữa người dùng. Tủ trưng bày trên hồ sơ.
- Hình vẽ: SVG tự vẽ cùng phong cách. **Cần tìm nguồn tọa độ sao và đường nối
  chòm sao có giấy phép dùng được** (một số bộ dữ liệu là GPL); kiểm tra trước
  khi đưa vào repo public.

### 3.5 Linh vật

- **Ô dẫn theo (tối đa 5):** 1 ô có sẵn (tài khoản nào cũng được tặng 1 con) ·
  1 ô khi đạt level 20 · 1 ô khi lần đầu lên hạng Vàng · 1 ô mua bằng 1.500 bụi
  sao (khoảng 3 tuần) · 1 ô bằng chìa khóa từ rương huyền thoại.
- **Tâm trạng:** học đều thì vui; 2 ngày không học thì buồn và kỹ năng tạm tắt
  tới khi học lại. Không bao giờ chết hay bỏ đi.
- **Lớn lên:** qua 4 hình dạng theo số ngày đã học khi dẫn con đó.
- **Kỹ năng XP:** mỗi con +5–10% XP hoặc tiện ích (giữ combo thêm 1 phút, rương
  hiếm hơn 2%). **Tổng XP thưởng từ linh vật tối đa +25%**, cộng chung với các
  phần thưởng khác.
- **Kỹ năng PvP** (dùng ở giai đoạn 5): mỗi con một kỹ năng chiến đấu, tổng lợi
  thế tối đa khoảng 20%.

### 3.6 Boss tuần

- Mỗi tuần 1 boss gom 15 từ người đó hay quên nhất (cùng thứ tự Weakest words).
- Thanh máu: mỗi câu Nhớ trừ máu, Quên thì boss hồi một ít; đánh nhiều lần
  trong tuần, tiến độ giữ lại.
- Chạy ở chế độ luyện tập: tính vào mục tiêu luyện tập, **không đổi lịch FSRS**.
- Thắng: 300 XP, 200 bụi sao, huy hiệu boss tuần.

### 3.7 Sự kiện

- **Giờ vàng:** mỗi ngày một giờ ngẫu nhiên trong 19:00–22:00 (múi giờ tài
  khoản), +100% XP; biết trước 15 phút (giai đoạn 4 gửi thông báo).
- **Chủ nhật:** +50% XP cả ngày.
- **Thử thách tháng:** một mục tiêu lớn mỗi tháng (ví dụ 1.000 lượt), huy hiệu
  chỉ lấy được trong tháng đó.
- Định nghĩa trong code; trang quản trị bật/tắt.

### 3.8 Dữ liệu (`…_economy.sql`, v19)

`stardust_ledger`, `inventory` (user_id, item_id, acquired_at, source),
`shop_days`, `chests` (id, rarity, opened_at, contents), `pet_slots`,
`active_pets`, `pet_progress`, `active_boosts`, `boss_weeks`, `events`. Danh mục
vật phẩm trong `shared/gamification/catalog.ts`.

### 3.9 Test

Mua không âm số dư, không mua trùng, mở rương một lần, tỉ lệ rương (thống kê với
seed cố định), trần +25% linh vật, tâm trạng linh vật, sửa streak, boss không
đổi lịch FSRS, nâng cấp từ v18.

---

## Giai đoạn 4 – Nhắc nhở (schema v20)

### 4.1 Thông báo (đã chốt cả 4 loại)

| Loại | Khi gửi |
|---|---|
| Streak sắp đứt | 20:00 và 22:30 giờ tài khoản, nếu hôm nay chưa đạt |
| Giải đấu | bị vượt khỏi vùng lên hạng, sắp vào vùng xuống hạng (tối Chủ nhật), kết quả tuần |
| Nhắc học | mỗi ngày vào giờ người dùng chọn, kèm số từ đang chờ |
| Bạn bè và sự kiện | bạn vượt bạn, lời thách đấu, giờ vàng sắp bắt đầu |

- Bật/tắt từng loại trong Settings; giờ yên lặng mặc định 23:00–07:00; tối đa
  6 thông báo/ngày.
- Xin quyền thông báo sau lần đạt mục tiêu ngày đầu tiên, không phải lúc mới vào.
- iPhone/iPad chỉ nhận web push khi đã "Thêm vào Màn hình chính" (iOS 16.4+);
  trang Settings hướng dẫn.

### 4.2 Kỹ thuật

- Khóa VAPID (biến `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`), bảng
  `push_subscriptions`, xử lý `push` và `notificationclick` trong `public/sw.js`,
  gửi bằng thư viện `web-push` trên server.
- **Cần bộ hẹn giờ chạy mỗi 15 phút.** Kiểm tra giới hạn Cron của gói Vercel
  đang dùng; nếu không đủ, dùng GitHub Actions `schedule` (miễn phí) gọi
  `POST /api/cron/notify` có `CRON_SECRET`.
- Server không có quyền đọc dữ liệu của mọi người (không service-role key):
  hàm definer `notify_due(token)` kiểm tra token với bản băm lưu trong database,
  rồi trả danh sách cần gửi (chỉ subscription và nội dung, không dữ liệu học).

### 4.3 Test

Chọn đúng người cần nhắc theo múi giờ và giờ yên lặng, không gửi trùng trong
ngày, token sai bị từ chối, subscription hết hạn (HTTP 410) bị xóa.

### 4.4 Chủ dự án làm

Tạo khóa VAPID và `CRON_SECRET` (lệnh có trong tài liệu), đặt trên Vercel, chạy
`…_notifications.sql`, thiết lập bộ hẹn giờ.

---

## Giai đoạn 5 – PvP (schema v21)

### 5.1 Chế độ

- **Xếp hạng ngẫu nhiên:** ghép người cùng tầm điểm; chờ quá 10 giây thì gặp
  bot giấu kín (tốc độ, tỉ lệ đúng, linh vật theo hạng; phần từ của bot lấy từ
  bộ từ phổ biến).
- **Đấu với bạn:** mời bạn đang online hoặc gửi link, 60 giây để nhận; không
  tính hạng, có XP, lưu lịch sử đối đầu ("Bạn 7 – 5 Minh").

### 5.2 Câu hỏi

- Cùng một dãy câu cho hai người: 50% từ từ vựng mỗi bên (chỉ từ có nghĩa tiếng
  Việt, không lưu trữ).
- Trước trận xếp hạng đầu tiên báo rõ: "Đối thủ sẽ thấy một số từ của bạn."
- 4 đáp án, mỗi câu ngẫu nhiên Anh→Việt hoặc Việt→Anh; đáp án sai ưu tiên cùng
  loại từ, không trùng nghĩa với đáp án đúng.
- Sau trận: từ của đối thủ mà mình chưa có → nút "Thêm vào từ vựng của tôi".

### 5.3 Luật trận

- 100 máu mỗi người, mỗi người làm theo tốc độ riêng.
- Đúng: đối thủ −10; đúng dưới 3 giây: −15 (chí mạng). Sai: khóa 3 giây.
- Tối đa 2 phút; hết máu thua; hết giờ ai còn nhiều máu hơn thắng (bằng nhau
  thì hòa).
- Linh vật: kỹ năng chiến đấu (sát thương, giảm khóa, khiên 1 đòn, hồi máu),
  tổng lợi thế tối đa khoảng 20%.
- Mất kết nối: 15 giây để vào lại (đồng hồ vẫn chạy); quá hoặc bấm thoát là
  thua; bỏ trận nhiều lần bị khóa ghép 5 phút.

### 5.4 Hạng và thưởng

- Điểm hạng PvP riêng (kiểu Elo, K = 32, bắt đầu 1.000), dùng tên 8 hạng.
  Mùa 1 tháng; cuối mùa quà theo hạng, điểm kéo về
  `1000 + (điểm − 1000) / 2`.
- Mỗi câu trả lời = một lượt luyện tập: 5 XP, tính mục tiêu luyện tập, không đổi
  lịch FSRS. Thắng +30 XP và bụi sao. Không giới hạn số trận; từ trận 21 trong
  ngày XP còn một nửa.

### 5.5 Kỹ thuật

- **Server làm trọng tài:** đề và đáp án lưu trong database; trình duyệt chỉ
  nhận câu hỏi và các lựa chọn, gửi lựa chọn lên API; server chấm, trừ máu, áp
  khóa 3 giây (từ chối câu trả lời trong lúc bị khóa), ghi lượt luyện tập.
- **Thời gian thực bằng Supabase Realtime** (Vercel không giữ kết nối): hai bên
  nghe thay đổi của dòng trận đấu (RLS chỉ cho hai người trong trận); lời mời
  và "đang online" dùng Presence.
- **Bot:** lịch hành động của bot sinh lúc bắt đầu trận (thời điểm, đúng/sai);
  mỗi lần người chơi gửi nhịp (1 giây/lần) hoặc trả lời, server áp các hành
  động đến hạn. Không có tiến trình nền.
- Ghép trận: hàng chờ trong database, ghép theo điểm (nới dần khoảng điểm theo
  thời gian chờ).
- Bảng: `pvp_ratings`, `pvp_queue`, `pvp_matches`, `pvp_questions`,
  `pvp_answers`, `pvp_seasons`, `pvp_head_to_head`.

### 5.6 Test

Chấm đúng/sai, chí mạng, khóa 3 giây ở server, hết giờ, hòa, đáp án không lộ
trước khi trả lời, chỉ hai người trong trận đọc được trận, Elo, mất kết nối 15
giây, bot tất định, XP giảm sau trận 20, câu trả lời được ghi như luyện tập và
không đổi lịch FSRS, nâng cấp từ v20.

---

## Thứ tự làm và điểm dừng

1. Duyệt tài liệu này (và bảng "Quyết định mặc định").
2. Làm từng giai đoạn trên một nhánh; mỗi giai đoạn: code + SQL + test + kiểm
   tra click thật trên `dev:mock-fsrs`, rồi commit/push khi chủ dự án đồng ý.
3. Chủ dự án chạy SQL của giai đoạn đó trên Supabase rồi mới bật tính năng
   (code tự tắt phần cần schema mới khi database chưa cập nhật).
4. Sau mỗi giai đoạn, chỉnh các con số (XP, bụi sao, tỉ lệ rương, sức bot) theo
   dữ liệu thật trước khi sang giai đoạn sau.
