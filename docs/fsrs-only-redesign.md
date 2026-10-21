# Thiết kế lại: FSRS là lịch duy nhất, bỏ mastery

Trạng thái: **đang triển khai** trên `main` (giao diện chưa làm, v15 chưa chạy); tiến độ trong [`fsrs-only-progress.md`](fsrs-only-progress.md).

Mục tiêu:

1. Bỏ hẳn mastery khỏi việc lập lịch: không còn `mastery`, `review_date`, `mastery_v1`, không còn lựa chọn lịch.
2. FSRS là lịch duy nhất, tính từ lịch sử trả lời của từng từ.
3. Vẫn có một chỉ số trực quan cho người dùng biết "từ này đã ôn tới đâu" — nhưng chỉ để hiển thị, **không tham gia vào việc tính ngày đến hạn**.
4. Giữ được dữ liệu cũ, không làm thẻ biến mất, không tạo backlog giả.

---

## 0. Các quyết định đã chốt

| Chủ đề | Quyết định |
|---|---|
| Người dùng | Hướng tới người dùng công khai; người Việt học tiếng Anh |
| Ngôn ngữ | UI switcher VI/EN; mặc định theo trình duyệt, fallback tiếng Việt; nghĩa của từ vẫn tiếng Việt |
| Lập lịch | FSRS là duy nhất; bỏ mastery, review_date, scheduler |
| Chỉ số tiến độ | `Sức nhớ` (Memory strength), 10 level suy ra từ stability; 5 nhãn: New, Learning, Familiar, Strong, Master |
| Hiển thị | Số + nhãn, ví dụ `Sức nhớ 6/10 · Strong` |
| Strength tụt | Chỉ hiện strength hiện tại; khi tụt hiện mũi tên nhỏ + "needs review", không đỏ, không shame |
| Level 10 | Nhãn `Master`; chỉ là nhãn hiển thị, không phải mastery lập lịch |
| Nghỉ hẳn | Không auto-retire; FSRS duy trì tự do; archive/resume thủ công hàng loạt ở Bank |
| Archive | Chỉ bulk ở Bank; từ archived ẩn khỏi queue và dashboard, hiện trong filter Archived, có count riêng |
| Level cao | Từ level 6 trở lên thu gọn definition tiếng Anh và example; mặt sau chỉ hiện nghĩa Việt + nút "Xem định nghĩa/ví dụ" |
| Nút trả lời | Giữ 2 nút Remember / Not remember |
| Từ mới/ngày | Không đặt trần cứng; import lớn thì hỏi và cho rải theo từ/ngày |
| Rải từ mới | Mặc định 20 từ/ngày, hiện trong ô có thể sửa; khi import thì cho chọn |
| Review/ngày | Mặc định hiện hết thẻ due; có setting trần tối đa N thẻ/ngày, mặc định tắt |
| Chế độ ôn | Giữ Everything due, Weakest words, Select words; weak dựa trên tổng hợp rủi ro FSRS |
| Mục tiêu ngày | Hai mục tiêu riêng: từ mới + review; hai vòng tròn cạnh nhau; sửa được trong dashboard |
| Mục tiêu từ mới | Tính khi từ được **đưa vào học** (lần đầu xuất hiện trong phiên ôn), không tính lúc chỉ nằm trong Bank |
| Mục tiêu review | Tính số từ due đã ôn; nếu đã hết từ due thì mục tiêu review vẫn đạt |
| Streak | Chỉ tăng khi đạt cả hai mục tiêu |
| Hết từ mới | Không tự đạt mục tiêu từ mới; có maintenance mode cho phép đặt mục tiêu từ mới = 0 |
| Phiên ôn | Không dừng khi đạt mục tiêu; mục tiêu chỉ dùng cho streak, vẫn có "ôn thêm" |
| Onboarding | Intro ngắn 3 màn + trang Help; gợi ý mục tiêu 10 từ mới + 30 review |
| FSRS trong UI | UI chính gọi "Smart review"; chi tiết FSRS trong Help/Settings |
| Retention | Chỉnh trong Advanced settings; mặc định 0.9 |
| Migration | Hybrid: replay lịch sử trước; thiếu lịch sử thì map mastery → stability/level hợp lý; giữ ngày đến hạn cũ; due quá khứ thì due ngay |
| Mastery 10 cũ | Tính lại FSRS rồi để FSRS tự do; không archive tự động |
| Người dùng cũ | Chỉ có 2 người; migration im lặng, không banner/email |
| True Mastery | Đổi tên thành Practice score; giữ tính năng, bỏ chữ mastery khỏi UI |
| Dashboard | Hero là số thẻ due + hai mục tiêu ngày; phân bố strength ở dưới |

---

## 1. Nguyên tắc thiết kế

Mastery hiện tại đang gánh bốn việc cùng lúc:

| Việc | Hiện tại | Sau khi đổi |
|---|---|---|
| Lập lịch | `mastery` quyết định khoảng ôn | FSRS `stability` + `difficulty` |
| Tiến độ | mastery 0–10 | `Sức nhớ` suy ra từ FSRS |
| Nghỉ hẳn | mastery 10 | Archive thủ công hàng loạt ở Bank |
| Ẩn định nghĩa | mastery > 5 | Level 6+ thu gọn |

Nguyên tắc: **một nguồn sự thật cho lập lịch là FSRS state**; các chỉ số khác chỉ đọc từ đó.

---

## 2. Chỉ số "Sức nhớ" (thay mastery)

Không lưu thêm cột tiến độ. Suy ra từ `fsrs_stability` (S, đơn vị ngày):

| Level | Stability S | Nhãn | Ý nghĩa gần đúng |
|---:|---:|---|---|
| 1 | chưa có state hoặc < 1 ngày | New | Chưa ôn lần nào |
| 2 | 1 – 2.9 ngày | Learning | Vừa nhớ lần đầu |
| 3 | 3 – 6.9 ngày | Learning | Bắt đầu bền |
| 4 | 7 – 13.9 ngày | Familiar | Nhớ qua tuần |
| 5 | 14 – 29.9 ngày | Familiar | Nhớ qua nửa tháng |
| 6 | 30 – 59.9 ngày | Strong | Nhớ qua tháng |
| 7 | 60 – 119.9 ngày | Strong | Nhớ qua 2 tháng |
| 8 | 120 – 239.9 ngày | Strong | Nhớ qua nhiều tháng |
| 9 | 240 – 364.9 ngày | Strong | Gần một năm |
| 10 | ≥ 365 ngày | Master | Bền dài hạn |

Ghi chú:

- FSRS **không có level**. Đây là thang hiển thị do sản phẩm đặt ra, chỉ đọc từ stability.
- Level 10 **không** có nghĩa là nghỉ. Từ vẫn được FSRS lên lịch; FSRS tự do nên có thể giãn hơn 1 năm nếu strength rất cao.
- `stability` độc lập với target retention. Đổi retention làm đổi ngày đến hạn, không làm đổi level.
- Hiển thị thêm `reps`, `lapses`, `lastReview`, `estimated recall now` trong trang chi tiết.
- Thanh tiến độ có thể dùng 10 đoạn; `percent = (level - 1) * 100 / 9`. Không dùng để lập lịch.

### Hiển thị

- Trên thẻ: `Sức nhớ 6/10 · Strong` thay cho `Mastery 6`.
- Trang chi tiết:
  - `Sức nhớ 6/10 · Strong`
  - `Stability 57 days · Difficulty 2.1`
  - `Reviewed 5× · 1 lapse`
  - `Next due in 57 days · Estimated recall now 88%`
- Bank: cột `Sức nhớ`, lọc/sắp xếp theo level hoặc band.
- Dashboard: phân bố 10 level + nhóm New / Learning / Familiar / Strong / Master.
- Tooltip: "Ước lượng sức nhớ từ FSRS. Chỉ số này không quyết định ngày ôn."
- Khi strength tụt: hiện số mới + mũi tên nhỏ `↓ needs review`; không dùng màu đỏ hoặc lời lẽ gây xấu hổ.

### Level 6+ thu gọn

- Level ≤ 5: mặt sau hiện đầy đủ nghĩa, definition tiếng Anh, example.
- Level ≥ 6: mặt sau chỉ hiện nghĩa tiếng Việt + nút `Xem định nghĩa/ví dụ`.
- Definition và example vẫn có, nhưng mặc định đóng; người dùng có thể mở nếu cần.
- Không ẩn hẳn, không xóa dữ liệu.

---

## 3. Vòng đời thẻ sau khi bỏ mastery

```
New (chưa có FSRS state, due_on = hôm nay)
  └─ trả lời lần đầu → FSRS state
       └─ các lần trả lời → S/D cập nhật → Sức nhớ tăng/giảm
            └─ Master (S ≥ 365 ngày) — vẫn được FSRS lên lịch tự do
                 └─ Archive thủ công hàng loạt ở Bank — không vào queue nữa
```

### Nghỉ hẳn

- **Không tự động retirement.** FSRS duy trì mãi; khoảng ôn tự giãn.
- Không đặt trần interval; 3/6/12 tháng chỉ là ví dụ, không phải mốc cứng.
- Archive/Resume là thao tác thủ công hàng loạt ở Bank:
  - chọn một hoặc nhiều từ;
  - `Archive` để ẩn khỏi queue/dashboard;
  - filter `Archived` để xem lại;
  - `Resume` để đưa lại vào lịch.
- Từ mastery 10 cũ: tính lại FSRS rồi để FSRS tự do; due quá khứ thì vào queue ngay. Chỉ có 2 người dùng nên không cần chiến dịch migration.

### Ẩn định nghĩa / ví dụ

- Bỏ `hideDetailsAboveMastery`.
- Thay bằng quy tắc level 6+ thu gọn như trên.
- Lý do: level cao nghĩa là đã đọc definition/example nhiều lần; chỉ cần nhắc lại nghĩa tiếng Việt để tiết kiệm thời gian.

---

## 4. Dữ liệu: schema mới

### `card_states`

Giữ:

- `fsrs_due timestamptz`
- `fsrs_stability double precision`
- `fsrs_difficulty double precision`
- `fsrs_last_review timestamptz`
- `fsrs_reps integer`
- `fsrs_lapses integer`
- `fsrs_state smallint` (0 new, 1 learning, 2 review, 3 relearning)
- `fsrs_scheduled_days integer`
- `fsrs_learning_steps integer`
- `fsrs_version text`

Thêm:

- `due_on date` — ngày đến hạn cho thẻ **chưa có FSRS state** (thẻ mới, thẻ cũ chưa từng trả lời). Không phải mastery.
- `revision bigint not null default 0` — chống ghi đè khi hai thiết bị cùng trả lời.
- `suspended_at timestamptz` — archive thủ công.
- `suspended_reason text` — `manual` (chỉ archive thủ công).

Bỏ:

- `mastery`
- `review_date`
- `scheduler`
- index `card_states_due_idx` cũ; thay bằng index cho `fsrs_due` và `due_on`.

Ràng buộc:

- FSRS all-or-nothing như hiện tại.
- `fsrs_due is not null or due_on is not null`.
- `revision >= 0`.

### `review_logs`

Giữ:

- `action`, `rating`, `fsrs_before`, `fsrs_after`, `fsrs_version`
- `reviewed_at`, `reviewed_on`, `duration_ms`, `confidence`, `session_id`, `request_id`

Thêm:

- `revision_before`, `revision_after`
- `due_on_before`, `due_on_after` (để Undo khôi phục thẻ chưa có FSRS state)
- `counted_toward_schedule boolean` (câu trả lời có làm thẻ dịch chuyển hay không)
- `counted_as_new boolean` (từ được đưa vào học lần đầu, dùng cho mục tiêu từ mới)

Bỏ khỏi lần ghi mới:

- `mastery_before`, `mastery_after`
- `review_date_before`, `review_date_after`
- `scheduler`

Xử lý dữ liệu lịch sử: giữ các cột cũ ở dạng nullable trong một phiên bản để đối soát/export, rồi drop ở migration dọn dẹp. Không xóa lịch sử trước khi backup.

### `user_settings`

- Bỏ `scheduler`.
- Giữ `fsrs_request_retention` (0.7–0.97, mặc định 0.9).
- Đổi tên `count_reviews_toward_mastery` → `count_reviews_toward_schedule`.
- Thêm:
  - `new_words_goal integer` — mục tiêu số từ mới đưa vào học mỗi ngày.
  - `review_goal integer` — mục tiêu số từ due ôn mỗi ngày.
  - `maintenance_mode boolean` — cho phép đặt mục tiêu từ mới = 0 khi đã hết từ.
  - `max_reviews_per_day integer` — tùy chọn, mặc định null = hiện hết.
  - `ui_language text` — `vi` hoặc `en`; mặc định theo trình duyệt, fallback `vi`.
  - `fsrs_parameters jsonb` — dành cho cá nhân hóa sau này.

Không còn `new_words_per_day` như một giới hạn cứng; đó là mục tiêu, không phải trần.

### View `vocabulary_cards`

- Bỏ `mastery`, `review_date`.
- Thêm `due_on`, `revision`, `suspended_at`, `suspended_reason`.
- Giữ nguyên các cột `fsrs_*`.

---

## 5. Migration và backfill

### Thứ tự

1. **v15 — additive** (`supabase/migrations/20261029090000_fsrs_only.sql`, đã viết 2026-10-21): thêm `due_on`, `revision`, `suspended_at`, `suspended_reason`; thêm cột settings; cập nhật view; hàm `record_fsrs_review`, `undo_fsrs_review`, `set_cards_suspended`; chưa drop cột cũ. **Backfill nằm luôn trong file này** (xem bên dưới).
2. **Deploy app FSRS-only**: app tự bật chế độ FSRS-only khi đọc được schema v15 (`capabilities.fsrsOnly`). Trước đó app chạy đường mastery cũ, nên deploy trước hay chạy SQL trước đều an toàn.
3. Từ v15, `mastery` và `review_date` **đóng băng**: không ghi nữa, lịch sử chép lại giá trị cũ (để quay về bản cũ vẫn đọc đúng).
4. **v16 — cleanup**: drop `mastery`, `review_date`, `scheduler` khỏi `card_states`; drop các cột mastery khỏi `review_logs` (sau khi export/archive); drop `scheduler` khỏi `user_settings`; cập nhật `app_schema_version`.

### Thuật toán backfill

Với từng thẻ:

1. Nếu đã có FSRS state hợp lệ: giữ nguyên. Không replay đè, vì retention của người dùng có thể đã đổi.
2. Nếu chưa có state và có lịch sử review:
   - Sắp xếp review theo `reviewed_at`.
   - Bắt đầu `state = null`.
   - Với mỗi review: `rating = remember ? Good : Again`; gọi `fsrsReview(state, rating, reviewedAt, settings)`.
   - Ghi state kết quả.
   - Dùng đúng `replayThroughFsrs` hiện có để tránh lệch logic.
3. Nếu chưa có state và **không có lịch sử dùng được**:
   - Map mastery → stability theo bảng dưới, tạo state ước lượng một lần.
   - `difficulty = 5`, `state = review`, `reps = 0`, `lapses = 0`, `version = 'legacy-mapped'`.
   - `fsrs_due = review_date` cũ, hoặc `today` nếu trống.
4. Nếu `mastery = 10` cũ:
   - Cùng quy tắc: replay nếu có lịch sử; nếu không, map S = 365 ngày.
   - Không suspend, không archive tự động; due quá khứ thì vào queue ngay.
5. Thẻ trong trash: xử lý cùng quy tắc, vẫn giữ `deleted_at`.

Bảng map mastery → stability khi thiếu lịch sử:

| Mastery cũ | Stability ước lượng | Level |
|---:|---:|---:|
| 1 | 0.5 ngày | 1 New |
| 2 | 1 ngày | 2 Learning |
| 3 | 3 ngày | 3 Learning |
| 4 | 7 ngày | 4 Familiar |
| 5 | 14 ngày | 5 Familiar |
| 6 | 30 ngày | 6 Strong |
| 7 | 60 ngày | 7 Strong |
| 8 | 120 ngày | 8 Strong |
| 9 | 240 ngày | 9 Strong |
| 10 | 365 ngày | 10 Master |

Đây là ước lượng một lần, không phải scheduling mastery. Sau lần trả lời đầu tiên, FSRS tự cập nhật.

### Kiểm tra sau backfill

- `total = has_fsrs + fallback_due`.
- Không có thẻ nào vừa không có FSRS vừa không có `due_on`.
- Với thẻ đã có FSRS state trước migration: so sánh state lưu và replay; chỉ báo khác biệt, không ghi đè.
- Đếm số thẻ due trong 30 ngày trước/sau; lưu báo cáo.
- Chạy `--dry-run` trên bản copy production trước.

### Đã làm thế nào (2026-10-21)

Không có script riêng và **không dùng service-role key** (quy tắc an toàn của dự án). Việc ước lượng được viết bằng SQL trong chính file v15, chạy một lần cho mọi tài khoản khi chủ dự án chạy file đó, đúng ý "chuyển im lặng":

- Từ **đã học** (mastery > 1, hoặc có ít nhất một câu trả lời còn hiệu lực) mà chưa có FSRS state → ước lượng theo bảng trên, `version = 'legacy-mapped'`.
- `fsrs_due` = 0 giờ của `review_date` cũ theo múi giờ người dùng; trống thì là lúc chạy (đến hạn ngay). Ngày quá khứ → đến hạn ngay.
- `fsrs_last_review` = câu trả lời cuối cùng còn hiệu lực; nếu không có thì lùi một stability so với `fsrs_due`, để lần trả lời đầu FSRS thấy đúng khoảng cách đã qua.
- Từ **chưa học** (mastery 1, không có câu trả lời) giữ nguyên là từ mới: `due_on = review_date` (trống thì app coi là đến hạn hôm nay).
- Từ đã có FSRS state: không đụng tới.
- File chạy lại được bao nhiêu lần cũng không đổi gì thêm (có test).

**Vì sao không replay lịch sử trước:** lịch sử trong database chỉ bắt đầu từ ngày chuyển khỏi Notion (2026-10-10), và từ khi có FSRS (v3) mọi câu trả lời đều đã ghi FSRS state. Từ chưa có state nhưng có lịch sử chỉ là vài từ được trả lời trong một hai ngày đầu. Replay một đoạn lịch sử ngắn như vậy cho từ mang mastery từ Notion sẽ cho sức nhớ thấp sai (ví dụ mastery 8 chỉ còn "Learning"), nên dùng bảng ước lượng cho mọi từ chưa có state.

---

## 6. Server và API

### Bỏ

- `server/scheduler-store.ts`, `MASTERY_ONLY`.
- `shared/scheduler/active.ts` (hoặc thay bằng `status.ts`).
- `shared/scheduler/comparison.ts` (so sánh mastery vs FSRS không còn nghĩa).
- `shared/scheduler/simulation.ts` (hoặc đổi thành "what-if retention").
- `ReviewRules` với `retiredAtMastery`, `hideDetailsAboveMastery`, `remember`, `notRemember`.
- `applyAction`, `reconcile` theo mastery.
- `NewWordDefaults.mastery`.
- API `chooseScheduler`, `SchedulerReport`.

### Giữ / đổi

- `shared/scheduler/fsrs.ts`: vẫn là nơi duy nhất dùng `ts-fsrs`.
- Thêm `shared/scheduler/strength.ts`:
  - `memoryStrength(state): { level, label, percent }`
  - `strengthBand(level)`
  - `isDetailCollapsed(level)` — true từ level 6.
- `ReviewAction` vẫn là 2 nút: `remember` → Good, `not_remember` → Again.
- `fsrsReview` giữ nguyên; `enable_short_term: false`, `enable_fuzz: false` trong v1.
- Không đặt `maximum_interval`; FSRS tự do.
- `fsrsRetrievability` giữ nguyên.

### `ReviewState` mới

```ts
interface ReviewState {
  fsrs: FsrsState | null;
  dueOn: IsoDate | null;   // fallback khi chưa có FSRS
  revision: number;
  suspended: boolean;
}
```

### Ghi một câu trả lời

1. Server đọc record + `revision`.
2. Tính `fsrs.after = fsrsReview(before, rating, answeredAt, settings)`.
3. Gọi `record_review` với `expected_revision`.
4. RPC:
   - `update card_states set fsrs_* = after, revision = revision + 1, due_on = null`
   - `where vocabulary_id = ... and revision = expected_revision`
   - Nếu không khớp: `conflict`.
5. Ghi `review_logs` với `rating`, `fsrs_before/after`, `revision_before/after`, `due_on_before/after`, `counted_toward_schedule`, `counted_as_new`.
6. Trả state mới, gồm level strength để UI hiển thị.

Không còn mastery CAS. `revision` thay thế.

### Undo

- Chỉ cho phép nếu câu trả lời là mới nhất và `revision` hiện tại khớp `revision_after`.
- Khôi phục `fsrs_before` và `due_on_before`.
- `revision = revision + 1` (không quay lại số cũ, để client cũ không ghi đè).
- Nếu `fsrs_before = null`: xóa toàn bộ `fsrs_*`, đặt lại `due_on`.

### Practice-only

- Vẫn ghi câu trả lời vào history.
- Không đổi FSRS state, `due_on`, `revision`.
- Đổi tên `countsTowardMastery` → `countsTowardSchedule` trong API/DB/UI.

### Eligibility / queue

```
nếu suspended → loại
nếu có FSRS state → dueDay = calendarDate(fsrs.due, timeZone)
ngược lại → dueDay = due_on
nếu dueDay <= today → vào queue
sắp xếp theo dueDay tăng dần
```

- Bỏ `mastered`, `missing_mastery`, `invalid_mastery`.
- Status mới: `new`, `due_today`, `overdue`, `upcoming`, `suspended`, `invalid`.
- `allowNotDue` vẫn dùng cho weak/selected review.
- Queue không dừng ở daily goal; goal chỉ để tính streak.

### API shapes

`VocabularyEntry`:

```ts
{
  id, word, meaning, definition, example, dateAdded, createdAt, updatedAt,
  dueDate: IsoDate,
  dueAt: string | null,
  reviewStatus: 'new' | 'due_today' | 'overdue' | 'upcoming' | 'suspended' | 'invalid',
  reviewable: boolean,
  suspended: boolean,
  memory: {
    level: 1..10,
    label: 'New' | 'Learning' | 'Familiar' | 'Strong' | 'Master',
    percent: number,
    stabilityDays: number | null,
    difficulty: number | null,
    reps: number,
    lapses: number,
    lastReview: string | null,
    retrievability: number | null,
    nextIntervalDays: number | null
  }
}
```

Bỏ `mastery`, `reviewDate`, `scheduledBy`.

`ReviewCard`: thay `mastery` bằng `memory` summary; thêm `detailCollapsed` (level ≥ 6).

`CreateEntryRequest`: bỏ `mastery`, `reviewDate`; từ mới có `due_on = hôm nay`.

`UpdateEntryRequest`: bỏ `schedule`; archive/resume là bulk endpoint ở Bank, không phải sửa từng từ.

`SchedulerReport` → `FsrsReport`: engine, retention, version, counts, strength distribution, workload 30 ngày. Không còn "active scheduler".

`/api/simulation`: đổi thành "what-if retention" (0.8 / 0.9 / 0.95) hoặc bỏ. Nếu giữ, chỉ replay FSRS, không so mastery.

`/api/goals`: đọc/ghi `new_words_goal`, `review_goal`, `maintenance_mode`; trả tiến độ hai mục tiêu và streak.

`/api/vocabulary/archive`: bulk archive/resume.

---

## 7. UI

### Components

- `MasteryPill` → `StrengthPill` (`Sức nhớ 6/10 · Strong`, band color, tooltip).
- `SchedulerSection` → `FsrsSection`:
  - engine `v5.4.2 using FSRS-6.0` (trong Help/Settings)
  - target retention (0.7–0.97) trong Advanced settings
  - strength legend
  - workload 30 ngày
  - goals, maintenance mode, optional max reviews/day
- `ScheduleSimulation` → `RetentionSimulation` hoặc xóa.
- `Flashcard`:
  - góc trên: `Sức nhớ 6/10 · Strong`;
  - level ≤ 5: mặt sau đầy đủ;
  - level ≥ 6: mặt sau chỉ nghĩa Việt + nút `Xem định nghĩa/ví dụ`;
  - khi strength tụt: mũi tên nhỏ `↓ needs review`.
- `WordDetailPanel`: mục `Sức nhớ`; bỏ chỉnh mastery/review date; không có archive từng từ (archive ở Bank).
- `VocabularyFields`: bỏ mastery và review date; ghi chú "Từ mới sẽ đến hạn hôm nay".
- `CompletionScreen`: "No words due today" / "All caught up"; không còn "full mastery".
- `ReviewPage`: đổi "Count toward mastery" → "Count toward schedule"; khi tắt, FSRS không đổi. Không dừng phiên khi đạt goal.
- `PracticeMastery` / `TrueMastery`: đổi nhãn thành `Practice score`.

### Pages

- `BankPage`: cột Sức nhớ; bỏ cột/filter/sort mastery; thêm filter band; sort theo strength/due/reps/lapses; bulk Archive/Resume; filter Archived.
- `DashboardPage`: hero là số thẻ due + hai vòng tròn mục tiêu (từ mới, review); phân bố strength ở dưới; count Master.
- `InsightsPage`: bỏ biểu đồ mastery; thêm phân bố strength, retention thực tế, workload.
- `WeakWordsPage`: bỏ mastery; hiển thị strength + lý do (lapses, recent failures, overdue, low stability).
- `CalendarPage`: StrengthPill.
- `SettingsPage`: bỏ lựa chọn scheduler; thêm FSRS section, Advanced retention, UI language, goals, maintenance mode, optional max reviews/day.
- `AddPage`, `ImportPage`, `AddWordDialog`, `AccountSettings`, `CollectionsPage`: bỏ copy mastery; import lớn hỏi có rải không, mặc định 20 từ/ngày trong ô sửa được.
- `BankFilters`, `bank-query.ts`, `vocabulary-form.ts`: bỏ mastery; thêm strength.
- `offline/ops.ts`, `send.ts`, `session-controller.ts`: bỏ mastery; gửi `expectedRevision`, `countsTowardSchedule`.
- `api-client.ts`, `settings.ts`, `counting-preference.ts`: đổi tên.
- Onboarding: 3 màn (Sức nhớ là gì, có thể tụt, FSRS quyết định ngày ôn) + link Help; gợi ý 10 từ mới + 30 review.
- UI language switcher: VI/EN, mặc định theo trình duyệt, fallback VI; nghĩa từ vẫn tiếng Việt.

---

## 8. Analytics, weak words, practice score

### Metrics

`MetricEntry`:

```ts
{
  strengthLevel: number | null;
  stabilityDays: number | null;
  reviewStatus: ReviewStatus;
  suspended: boolean;
  dateAdded: IsoDate | null;
}
```

`SummaryMetrics`:

- `total`
- `new`, `learning`, `familiar`, `strong`, `master`
- `suspended`
- `dueToday`, `overdue`, `upcoming`
- `invalid`
- `addedToday`, `addedThisWeek`, `missingDateAdded`

`masteryDistribution` → `strengthDistribution` (10 buckets).

### Weak words

Bỏ `mastery`, `retired`, `slipped_after_progress` theo mastery. Thay bằng tổng hợp rủi ro:

- `stabilityDays` thấp
- `difficulty` cao
- `lapses` nhiều
- `recentFailures`
- `retrievability` thấp
- `long_overdue`
- `incomplete`

`progressMastery` → `progressStrengthLevel` (ví dụ level ≥ 6).
`rankWeakWords` sắp theo risk score, không theo mastery.

### Practice score

Đây là chỉ số analytics riêng (0–100 từ practice), không phải scheduling mastery. Giữ, nhưng:

- Đổi nhãn UI thành `Practice score`.
- Bỏ chữ "mastery" khỏi tên public.
- Không dùng chỉ số này để lập lịch.

---

## 9. Import / export / offline

### Export v2

- Bỏ `mastery`, `reviewDate`, `scheduler`.
- Thêm:
  - `dueOn`
  - `fsrs` (state đầy đủ)
  - `suspendedAt`, `suspendedReason`
  - `settings.fsrsRequestRetention`
  - `settings.countReviewsTowardSchedule`
  - `settings.newWordsGoal`, `reviewGoal`, `maintenanceMode`, `maxReviewsPerDay`, `uiLanguage`
- `reviewHistory`: bỏ mastery fields; thêm `revisionBefore/After`, `dueOnBefore/After`, `countedTowardSchedule`, `countedAsNew`.
- Bump `EXPORT_VERSION` lên 2.

### Import

- File backup mới: khôi phục nguyên FSRS state + due fallback.
- File cũ (v1): đọc `reviewDate` → `dueOn`; bỏ qua `mastery`; nếu có `fsrs` thì dùng.
- Import từ vựng thường: không nhận mastery/review date; từ mới due hôm nay; nếu import lớn, hỏi có rải theo từ/ngày không.
- Không replay lịch sử khi import vựng; chỉ backup restore mới khôi phục state.

### Offline

- Client không tính FSRS. Câu trả lời offline vẫn xếp hàng và gửi `answeredAt`, `expectedRevision`.
- UI hiển thị "Đang chờ đồng bộ" thay vì đoán ngày mới.
- Nếu revision lệch: 409, reload thẻ; câu trả lời vẫn nằm trong outbox để thử lại sau khi reload.
- Không dựa vào mastery/review date trong cache local.

---

## 10. Kiểm thử

### Unit

- `strength.ts`: thresholds, level, band, detail collapse.
- `review-logic`: eligibility, queue sort, statuses.
- `fsrs.ts`: giữ test hiện có; thêm level/retrievability.
- `metrics`: strength distribution, summary.
- `weak-words`: FSRS inputs, ranking.
- `goals`: hai mục tiêu, streak, review goal khi hết due, maintenance mode.
- `simulation`: nếu giữ, chỉ FSRS.

### Database

- Migration v15: columns, constraints, view.
- Backfill: replay, fallback mapping, mastery 10.
- `record_review`: CAS revision, idempotency, missing FSRS refused.
- `undo_review`: restore state + revision.
- Bulk archive/resume.
- Old DB version compatibility (nếu còn).

### Server/API

- Review flow: 2 buttons, practice-only, undo, conflict.
- Vocabulary create/update: no mastery.
- Queue: FSRS due + fallback + suspended.
- Analytics: strength distribution.
- Goals: two goals, streak, exhaustion rules.
- Export/import v2.
- Bulk archive.

### UI

- Card shows strength, not mastery.
- Level 6+ collapse + expand.
- Bank filter/sort/archive.
- Dashboard two goals + strength distribution.
- Settings retention/language/goals.
- Add/Edit no mastery.
- Onboarding.
- Offline sync.

### Kiểm tra thủ công trước production

- So sánh due counts trước/sau migration.
- Kiểm tra 20 thẻ mẫu: state, level, due.
- Kiểm tra mastery 10 cũ: recalc, due, level.
- Kiểm tra một thẻ mới: trả lời → state → level → due.
- Kiểm tra level 6+ collapse.
- Kiểm tra undo.
- Kiểm tra export → import lại.
- Kiểm tra archive/resume hàng loạt.
- Kiểm tra streak khi hết due / hết từ mới / maintenance mode.

---

## 11. Phases và ước lượng

| Phase | Nội dung | Ước lượng |
|---|---|---:|
| 0 | Chốt quyết định sản phẩm | 1–2 ngày |
| 1 | Shared model + strength + review logic | 2–3 ngày |
| 2 | Migration v15 + backfill script | 4–6 ngày |
| 3 | Server/API/repository FSRS-only | 4–6 ngày |
| 4 | UI toàn bộ (strength, goals, onboarding, language) | 6–8 ngày |
| 5 | Export/import/offline + cleanup v16 | 3–4 ngày |
| 6 | Test, docs, staging, rollout | 3–5 ngày |
| **Tổng** | | **~4–5 tuần** (một dev có kinh nghiệm) |

Có thể rút ngắn bằng cách:

- Giữ 2 nút Remember/Not remember (đã chốt).
- Chưa làm 4 nút.
- Chưa cá nhân hóa FSRS parameters.
- Giữ `due_on` fallback lâu dài thay vì cố backfill mọi thẻ.
- Làm onboarding và bilingual UI ở phase sau nếu cần launch sớm.

---

## 12. Tiêu chí hoàn thành

- Không còn `mastery`, `review_date`, `scheduler` trong schema cuối.
- Không còn lựa chọn lịch; FSRS là lịch duy nhất.
- Mọi thẻ có FSRS state hoặc `due_on`; không thẻ nào mất tích.
- Trả lời cập nhật FSRS nguyên tử với `revision`; Undo khôi phục đúng.
- Queue dùng ngày FSRS; mastery 10 cũ được recalc, không bị archive tự động.
- UI hiển thị `Sức nhớ N/10 · <band>` và số lần ôn; không còn chữ "Mastery" trong ngữ cảnh lập lịch.
- Level 6+ thu gọn definition/example, có nút mở.
- Dashboard/Bank/Insights lọc và thống kê theo strength.
- Hai mục tiêu ngày hoạt động đúng: new goal tính khi đưa vào học; review goal tự đạt khi hết due; streak cần cả hai; maintenance mode cho new goal = 0.
- Archive/resume hàng loạt ở Bank; archived ẩn khỏi dashboard/queue.
- UI switcher VI/EN; nghĩa từ vẫn tiếng Việt.
- Export v2 và backup import giữ được FSRS state + goals.
- Offline gửi `expectedRevision`; xử lý 409 đúng.
- Toàn bộ test, typecheck, lint pass; docs cập nhật.

---

## 13. Rủi ro và rollback

| Rủi ro | Giảm thiểu |
|---|---|
| Backfill sai | dry-run, so sánh stored vs replay, backup, batch nhỏ |
| Mastery 10 cũ làm ngập queue | Chỉ 2 người dùng; due quá khứ vào ngay, theo dõi workload |
| Người dùng hiểu strength là lịch | tooltip + Help + copy rõ ràng; strength chỉ đọc |
| Khoảng ôn quá dài gây bất ngờ | hiển thị next due; retention Advanced; không đặt trần cứng |
| Streak gãy khi hết từ mới | maintenance mode cho new goal = 0 |
| Người dùng hiểu "Master" là mastery | Help ghi rõ đây là nhãn sức nhớ, không phải lập lịch |
| Offline lệch state | revision CAS, outbox, reload khi 409 |
| Rollback sau khi bỏ mastery | giữ cột cũ đến v16; rollback = restore backup + deploy tag cũ |
| Scope lớn, nhiều test | chia phase, không làm 4 nút/cá nhân hóa trong v1 |
