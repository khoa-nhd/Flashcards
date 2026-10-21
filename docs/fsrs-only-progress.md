# Tiến độ: FSRS là lịch duy nhất

Cập nhật: 2026-10-21 (lần 2). File này ghi lại phần **đã làm** và **còn lại** của kế hoạch
[`fsrs-only-redesign.md`](fsrs-only-redesign.md), để người làm tiếp (người hay AI) bắt đầu
đúng chỗ. Đọc cả hai file trước khi sửa code.

---

## 1. Tình trạng chung

| Phần | Trạng thái |
|---|---|
| Nhánh làm việc | `main` (chủ dự án yêu cầu gộp vào `main` ngày 2026-10-21; nhánh `fsrs-only` đã gộp và xóa). **Chưa push** |
| Typecheck / lint / build | Sạch |
| Test | 76 file, 1880 test, tất cả đạt |
| Migration v15 | Đã viết: `supabase/migrations/20261029090000_fsrs_only.sql`. **Chưa chạy trên database thật** |
| Server (lưu, Undo, archive, hàng đợi) | Xong và có test qua HTTP thật + schema thật + RLS |
| Giao diện (Phase 4) | **Chưa bắt đầu** |

### An toàn khi deploy (push `main` = Vercel deploy)

- App chỉ bật chế độ FSRS-only khi database báo **schema v15** (`capabilities.fsrsOnly`).
  Trước đó mọi thứ chạy đúng như `main` (đường mastery, kể cả lựa chọn "FSRS in charge" của v8).
- Vì vậy: deploy nhánh này trước khi chạy SQL → app chạy như cũ. Chạy SQL trước khi deploy →
  app cũ vẫn chạy được (các hàm v8 `record_review`/`undo_review` vẫn còn).
- Settings chỉ giục chạy SQL tới **v14** (`RECOMMENDED_SCHEMA_VERSION` trong `server/supabase/supabase-database.ts`),
  nên khi deploy bản này, app không bảo chủ dự án chạy v15. Nâng hằng số này lên 15 khi giao diện đã xong.
- **Nhưng giao diện chưa làm**: nếu chạy v15 rồi deploy nhánh này ngay, server đã ở chế độ
  FSRS-only còn màn hình vẫn hiện "Mastery" (lúc này là level sức nhớ), ô sửa mastery/ngày
  bị server lặng lẽ bỏ qua. Chỉ chạy v15 + deploy khi Phase 4 đã xong.

---

## 2. Đã làm

### Quyết định của chủ dự án dùng trong phần này (2026-10-21)

- Bỏ mastery, chuyển im lặng (chỉ 2 người dùng).
- Từ chưa có FSRS: ước lượng từ mastery theo bảng (hybrid); giữ ngày đến hạn cũ; quá khứ → đến hạn ngay;
  mastery 10 cũ → S = 365 ngày, không archive tự động.
- Trong lúc chuyển, `mastery` và `review_date` **đóng băng** (không ghi nữa, xóa ở v16), để quay về bản cũ
  vẫn đọc đúng.
- Không dùng service-role key: bước ước lượng nằm trong file SQL v15. Lý do không replay lịch sử: xem
  `fsrs-only-redesign.md` mục 5.

### Migration v15 (`20261029090000_fsrs_only.sql`)

- `card_states`: `due_on`, `revision`, `suspended_at`, `suspended_reason` + ràng buộc + index; trigger
  `card_states_default_due_on` chép `review_date` vào `due_on` khi tạo từ mới.
- `review_logs`: `revision_before/after`, `due_on_before/after`, `counted_toward_schedule`, `counted_as_new`.
- `user_settings`: `study_goal_new_words`, `study_goal_reviews`, `maintenance_mode`, `max_reviews_per_day`,
  `ui_language` (null = theo trình duyệt).
- View `vocabulary_cards` thêm 4 cột mới.
- Hàm: `record_fsrs_review` (khóa dòng thẻ, chống trùng request id, chống ghi đè bằng revision,
  từ chối thẻ archived, câu trả lời không tính thì không đổi gì), `undo_fsrs_review` (chỉ câu cuối,
  revision luôn tăng; câu trả lời từ trước v15 thì nhờ `undo_review` cũ), `set_cards_suspended`
  (archive/resume tối đa 500 từ, tăng revision), `card_fsrs_json`.
- Ước lượng FSRS cho từ đã học chưa có state; từ chưa học giữ là từ mới. Chạy lại không đổi gì.

### Server

| File | Đã làm |
|---|---|
| `shared/api.ts` | Cờ `capabilities.fsrsOnly`; các schema của phần dở trước (strength, goals, archive, …) |
| `server/vocabulary-repository.ts` | Kiểu `FsrsReviewWrite`, `FsrsReviewResult`, `FsrsUndoResult`, `FsrsCardState`; `applyFsrsReview?`, `undoFsrsReview?` |
| `server/supabase/supabase-database.ts` | `LATEST_SCHEMA_VERSION = 15`; `recordFsrsReview`, `undoFsrsReview`, `setCardsSuspended` (qua RPC), `fsrsFromJson`; bỏ ghi `due_on` riêng sau khi tạo từ (trigger làm) |
| `server/supabase/supabase-repository.ts` | `fsrsOnly` từ v15; record/entry mang `fsrs`, `dueOn`, `revision`, `suspended`; `applyFsrsReview`, `undoFsrsReview`, `setEntriesSuspended` |
| `server/review-service.ts` | FSRS-only chỉ bật theo `capabilities.fsrsOnly`; `applyFsrsDecision` viết lại (revision, kiểm tra đến hạn chỉ với thẻ người dùng đã thấy, xác nhận trạng thái lưu được); Undo FSRS-only; lựa chọn "FSRS in charge" kiểu v8 được trả lại như `main` |
| `server/vocabulary-service.ts` | FSRS-only chỉ theo cờ; từ mới không nhận mastery từ request, đến hạn hôm nay (hoặc ngày rải import); không lộ dữ liệu FSRS nội bộ ra API |
| `server/create-app.ts` | `POST /api/vocabulary/archive`; import nhận `wordsPerDay` |
| `server/supabase/supabase-accounts.ts` | Truyền `fsrsOnly` vào `VocabularyService` |

### Trình duyệt (chỉ phần lõi, chưa có giao diện mới)

- Gửi `expectedRevision` cùng câu trả lời khi thẻ có revision (`session-controller.ts`, `offline/ops.ts`, `offline/send.ts`).
- Sau Undo, thẻ hiện lại mang revision mới từ server (`session-machine.ts`), nên trả lời lại không bị từ chối.

### Test mới

- `tests/server/fsrs-only-api.test.ts` (18): từ mới, trả lời, trùng request, thiết bị cũ, câu trả lời không tính,
  trả lời sớm, tài khoản khác, Undo, archive; và chạy file v15 trên database v14 có dữ liệu cũ.
- `tests/shared/strength.test.ts` (35): thang sức nhớ, hàng đợi và trạng thái FSRS-only.
- `tests/client/session-controller.test.ts`: gửi revision, revision sau Undo.
- `tests/server/gateway-versions.test.ts`: các hàm v15 chỉ được gọi từ v15.
- Các test cũ của đường mastery chạy trên database dừng ở v14 (`MASTERY_ERA_MIGRATIONS` trong
  `tests/helpers/test-database.ts`), vì đó vẫn là thứ production đang có.

---

## 3. Còn lại

| Phase | Còn thiếu |
|---|---|
| 3. Server/API | Route mục tiêu ngày (`/api/goals` hai mục tiêu, streak cần cả hai, maintenance mode); đếm "từ mới" bằng `counted_as_new`; trần review/ngày (`max_reviews_per_day`); lưu `ui_language`; weak words theo rủi ro FSRS; analytics/insights theo strength; bỏ chỉnh mastery/ngày ở `PATCH /api/vocabulary/:id` cho rõ ràng (hiện server bỏ qua phần lịch); **mock repository** (`npm run dev:mock`) chưa có chế độ FSRS-only, cần có để làm giao diện |
| 4. Giao diện | Tất cả: StrengthPill, thẻ thu gọn từ level 6 + nút mở, Bank (cột/lọc Sức nhớ, archive hàng loạt, lọc Archived), Dashboard hai vòng mục tiêu + phân bố strength, Settings (retention nâng cao, ngôn ngữ, mục tiêu, maintenance mode), đổi tên Practice score, onboarding 3 màn, switcher VI/EN, import hỏi rải theo từ/ngày (mặc định 20) |
| 5. Export/import/offline, v16 | Export v2, đọc file v1; offline đã gửi `expectedRevision` nhưng cần xử lý 409 bằng tải lại thẻ; migration dọn dẹp v16 |
| 6. Kiểm thử, docs, rollout | Kiểm tra thủ công trước production (mục 10 của kế hoạch); hướng dẫn chủ dự án chạy v15 |

---

## 4. Điểm cần chú ý

1. **Đừng chạy v15 trên database thật trước khi Phase 4 xong** (xem mục 1).
2. `npm run dev` dùng dữ liệu thật; tự kiểm tra bằng `npm run dev:mock` (cổng 5174). Mock hiện vẫn ở đường mastery.
3. Không dùng service-role key ở đâu cả.
4. Luật "Weakest words" ngày 2026-10-15 đã được thay trên `main` bằng cài đặt "Count toward mastery"; đường FSRS-only
   dùng cùng cài đặt đó (`countsTowardSchedule`/`countsTowardMastery`).
5. `tsc-errors.txt`, `tsc-errors2.txt`, `tsc-errors3.txt` ở thư mục gốc là file tạm của công cụ khác (kết quả tsc,
   UTF-16). Không commit; hỏi chủ dự án trước khi xóa.

---

## 5. Nhánh `newfeature` (không liên quan trực tiếp, vẫn dở)

- `newfeature`, `merge`, `merge-fresh`, `origin/newfeature` trỏ vào `3515925`; 16 commit chưa có trong `main`,
  tách từ `032f3a7` (2026-10-11), đi sau `main` 59 commit. Một worktree của opencode mở ở đó.
- Cần chủ dự án quyết: gộp từng phần, bỏ, hay giữ tham khảo.

---

## 6. Bắt đầu làm tiếp

1. Cho mock repository chế độ FSRS-only để làm giao diện với `npm run dev:mock`.
2. Phase 3 còn lại: mục tiêu ngày + streak, trần review/ngày, ngôn ngữ, weak words theo FSRS.
3. Phase 4: giao diện, kiểm tra bằng click thật trong trình duyệt (cả điện thoại và máy tính).
4. Phase 5, 6; nâng `RECOMMENDED_SCHEMA_VERSION` lên 15; rồi mới hướng dẫn chủ dự án chạy v15 và deploy.

Lệnh kiểm tra:

```bash
npx tsc --noEmit
npx vitest run
npx eslint .
npm run build
```
