# Product Blueprint V1.0 — Kế hoạch sản phẩm & Lộ trình Flashcards

| | |
| --- | --- |
| **Phiên bản** | V1.0 |
| **Ngày lập** | 2026-10-20 |
| **Trạng thái tài liệu** | Tổng hợp các định hướng sản phẩm **đã được PO chấp thuận** (sáu lĩnh vực duyệt ngày 2026-10-15). Tài liệu này không tự tạo yêu cầu mới; mọi nội dung chưa được duyệt đều ghi rõ là **OPEN DECISION**. |
| **Phạm vi** | Tài liệu sản phẩm + lộ trình cấp cao. Không phải thiết kế kỹ thuật: không đi sâu thuật toán, schema, API hay chi tiết component. |
| **Vị trí** | `docs/product-blueprint-v1.0.md` (tài liệu duy nhất của FC-DOC-016) |
| **Kho lưu trữ** | Nhánh `newfeature` @ `8d76720`, toàn bộ tiến độ đang nằm trong working tree chưa commit. |

**Các ký hiệu trạng thái dùng trong tài liệu này:**

| Ký hiệu | Ý nghĩa |
| --- | --- |
| **APPROVED REQUIREMENT** | Định hướng sản phẩm đã được PO duyệt rõ ràng. |
| **REPORTED IMPLEMENTED** | Một workstream trước đó báo cáo đã triển khai (tin báo cáo, không phải xác minh độc lập). |
| **REPO CONFIRMED** | Có bằng chứng trực tiếp từ kiểm tra kho mã trong tác vụ này (tệp, migration, tài liệu tồn tại). |
| **PARTIAL** | Có bằng chứng cho một phần, chưa đủ cho toàn bộ yêu cầu. |
| **UNVERIFIED** | Chưa đủ bằng chứng xác minh. |
| **OPEN DECISION** | Cần điều tra thêm hoặc cần PO quyết định. |
| **NOT STARTED** | Không tìm thấy dấu hiệu triển khai. |

---

## 1. Mục đích, phiên bản và phạm vi tài liệu

Tài liệu này ghi lại **Product Blueprint V1.0** của trang web học từ vựng Flashcards
đang tồn tại, để một AI agent, nhà phát triển hoặc PO trong tương lai hiểu: chúng ta
xây cái gì và tại sao; những lĩnh vực sản phẩm nào được duyệt; nguyên tắc nào điều
phán quyết định; đã làm được gì theo bằng chứng; còn thiếu gì; và giai đoạn lớn kế
tiếp là gì.

Đây **không** phải bài thiết kế lại sản phẩm. Sản phẩm là một trang web sẵn có đang
tiến hóa từng bước (**incremental evolution**), không phải ứng dụng mới dựng lại từ
đầu.

Nguồn thẩm quyền (thứ tự ưu tiên): (1) các yêu cầu Blueprint V1.0 và quyết định PO
trong brief của tác vụ này; (2) tài liệu và mã nguồn hiện có trong kho; (3) các báo
cáo workstream; (4) phần diễn giải của tác vụ này — luôn được gắn nhãn.

## 2. Tóm tắt điều hành

Flashcards đang tiến hóa từ một **bộ công cụ học từ vựng** thành một **hệ sinh thái
học từ vựng mạch lạc**: khám phá từ (Discovery), tổ chức và mô tả từ (Library &
Word Profile), kết nối tri thức (Vocabulary Maps), đánh giá và luyện tập (Review,
Practice, Exam — có sẵn), diễn giải bằng chứng học (Learning Intelligence — giai
đoạn tới) và điều phối trải nghiệm (Learning Experience — theo sau).

**Mục tiêu học tập cốt lõi: từ vựng sử dụng được trong ngữ cảnh** (*usable
vocabulary in context*), không phải đào sâu mọi từ đến tận cùng. Một từ không bắt
buộc phải đi qua mọi phương pháp học; học linh hoạt theo ngữ cảnh và nhu cầu hiện
tại. Ứng dụng phải **vẫn hữu ích khi không có AI**; AI là phần nâng cao, không phải
phụ thuộc bắt buộc.

**Trạng thái hiện tạithực trạng theo bằng chứng (chi tiết §10):**

- **Nền tảng & bảo mật** (FC-VERIFY-006, FC-HARDEN-007, FC-RC-FIX-009/011,
  FC-RELEASE-012, FC-SEC-013): báo cáo triển khai + xác minh cục bộ — **REPORTED
  IMPLEMENTED**; migration v13–v17 có trong kho — **REPO CONFIRMED**; hosted
  Supabase — **UNVERIFIED**.
- **Vocabulary Maps** (FC-MAPS-014): 8 trải nghiệm bản đồ được báo cáo đạt PASS —
  **REPORTED IMPLEMENTED**; file v18, trang `MapsPage`, test suites có trong kho —
  **REPO CONFIRMED**; hosted + trình duyệt thật — **UNVERIFIED**.
- **Discovery & Input** (FC-DISC-015): 6 hướng được báo cáo triển khai, báo cáo
  cuối tồn tại tại gốc kho — **REPORTED IMPLEMENTED**; file v19, `DiscoverPage`,
  `docs/discovery.md` có trong kho — **REPO CONFIRMED**; hosted + trình duyệt thật —
  **UNVERIFIED**.
- **Learning Intelligence** và **Learning Experience**: phần lớn chưa bắt đầu —
  **NOT STARTED** (một số năng lực lân cận đã có sẵn, xem §10).

**Giai đoạn sản phẩm lớn tiếp theo: Learning Intelligence**, kế tiếp là Learning
Experience, tùy khoảng trống và phụ thuộc phát hiện được (§9, §11).

## 3. Tầm nhìn sản phẩm & kết quả học tập mục tiêu

Sản phẩm là một trang web học từ vựng sẵn có đang tiến hóa lớn, tăng dần, hướng tới
Blueprint V1.0 — biến một **bộ công cụ từ vựng rời rạc** thành **hệ sinh thái học
từ vựng** giúp người học:

1. **Khám phá** những từ và biểu đạt hữu ích (*Discover useful words*).
2. **Hiểu** nghĩa, sự khác biệt, quan hệ và cách dùng của chúng (*Understand*).
3. **Lưu và tổ chức** từ vựng họ chủ động chọn giữ lại (*Save and organize*).
4. **Kết nối** tri thức giữa các từ, khái niệm, ngữ cảnh và việc học cá nhân (*Connect*).
5. **Luyện tập** từ vựng trong ngữ cảnh có ý nghĩa (*Practise*).
6. **Phát triển** khả năng nhận diện, gọi lại, sử dụng và linh hoạt (*Recognition,
   Recall, Usage, Flexibility*).
7. **Hiểu tiến độ** và các lỗi lặp đi lặp lại của mình (*Progress & recurring errors*).
8. **Tiếp tục học** qua các phiên học phù hợp và hành động tiếp theo được gợi ý
   (*Continue learning*).

Kết quả học tập kỳ vọng (theo tiêu chí thành công đã duyệt):

- Người học hiểu và **dùng được từ vựng trong ngữ cảnh có ý nghĩa**.
- Cải thiện trên cả bốn chiều: Recognition, Recall, Usage, Flexibility.
- Nhận diện và xử lý được các lỗi lặp lại.
- Nối được các từ với nhau và khám phá được từ vựng liên quan.
- Hoạt học tạo ra tiến độ dài hạn hữu ích, **không phải chỉ đếm hoạt động bề mặt**.

## 4. Người dùng mục tiêu & nhu cầu cốt lõi

> **Nguồn:** phần này rút từ định hướng đã duyệt (§4 brief) — không có nghiên cứu
> người dùng định lượng nào trong kho. Việc mô tả "ai là người dùng" ở mức persona
> chi tiết hơn là **OPEN DECISION** chờ PO.

- **Người học từ vựng đang dùng trang web hiện tại** — muốn mở rộng việc học vượt
  quá flashcard và ôn tập có lịch.
- Nhu cầu cốt lõi (đáp ứng 8 kết quả học tập ở §3):

| Nhu cầu | Lĩnh vực sản phẩm phục vụ |
| --- | --- |
| Gặp được từ mới một cách tự nhiên và có chủ đích | Discovery & Input |
| Lưu và tổ chức đúng những từ mình muốn giữ | Vocabulary Library & Word Profile |
| Hiểu nghĩa, sắc thái, quan hệ giữa các từ | Word Profile, Vocabulary Maps, Learning Intelligence |
| Luyện tập trong ngữ cảnh, không chỉ thuộc mặt chữ | Review, Practice, Learning Intelligence |
| Thấy mình đang ở đâu, đang sai ở đâu | Learning Intelligence, Reports |
| Tiếp tục từ chỗ đang dở mà không phải dựng lại quy trình | Learning Experience (Home, Sessions) |

## 5. Triết lý sản phẩm & nguyên tắc không mặc cả

- **Từ vựng dùng được trong ngữ cảnh** là mục tiêu học tập chính — không phải độ sâu
  nghiên cứu cho từng từ.
- **Học linh hoạt theo ngữ cảnh**: một từ không phải đi qua mọi phương pháp.
- **AI hữu ích nhưng không bắt buộc**: ứng dụng phải chạy đủ tốt khi không có AI;
  AI nâng cao khám phá, giải thích, tạo nội dung và gợi ý.
- **Tiến hóa tăng dần thay vì dựng lại**: giữ gìn khả năng hiện có, cải thiện theo
  từng bước có ranh giới.
- **Bốn trạng thái khác nhau, không bao giờ đồng nhất**: gợi ý của AI, nội dung sinh
  tạm, từ vựng đã lưu, bằng chứng thành thạo.
- **Thư viện không phải bãi chứa từ**: Library là tập từ người dùng *chủ động chọn
  giữ*; một hành động lưu do người dùng bấm tạo/cập nhật từ vựng.
- **Tôn trọng dữ liệu và chỉnh sửa của người dùng** khi làm giàu hoặc cập nhật hồ sơ.
- Quyết định sản phẩm phải cân nhắc: **giá trị học tập, UX, độ tin cậy, phụ thuộc,
  chi phí, rủi ro**.

## 6. Sáu lĩnh vực sản phẩm đã được duyệt

> Toàn bộ §6 là **APPROVED REQUIREMENT** (duyệt 2026-10-15). Trạng thái triển khai
> tách riêng ở §10 để không trộn yêu cầu với bằng chứng.

### Lĩnh vực 1 — Vocabulary Maps (Bản đồ từ vựng)

**Tám hướng bản đồ, mỗi hướng là một trải nghiệm học riêng:**

1. **Semantic Map** — quan hệ theo nghĩa, gắn theo *sense* (nghĩa cụ thể), quan hệ
   có nhãn, các cụm từ (*clusters*), và **giải thích sự khác biệt**.
2. **Word Family Map** — từ gốc/động từ gốc với các biến thể Derivation &
   Inflection rõ ràng; người dùng có thể bắt đầu từ bất kỳ từ nào trong gia đình.
3. **Collocation Map** — các tổ hợp từ có nghĩa và quan hệ dùng từ.
4. **Thematic Map** — từ vựng quanh một chủ đề.
5. **Nuance & Contrast Map** — tương đồng, đối lập, sắc thái và cách dùng phù hợp.
6. **Scenario Map** — từ vựng nối với tình huống và ngữ cảnh.
7. **Communicative Function Map** — từ vựng tổ chức theo mục đích giao tiếp.
8. **Personal Knowledge overlay** — tri thức từ vựng cá nhân nối với việc khám phá
   bản đồ.

**Yêu cầu sản phẩm của lĩnh vực này:**

- Đây là **các trải nghiệm học distinct**, có cấu trúc riêng — không phải một đồ thị
  chung với bộ lọc khác nhau.
- Bản đồ **kết nối với Vocabulary Library/Word Profile**, có thể chứa từ do AI phát
  hiện chưa lưu.
- Từ đã có trong thư viện phải **vẫn hiển thị được** ở bản đồ phù hợp.
- AI hỗ trợ mở rộng bản đồ tự động và có hướng dẫn (*automatic & guided expansion*).
- **Gợi ý AI không tự thành từ vựng đã lưu**; người dùng chọn từ nào để lưu.
- **Lưu bản đồ ≠ Lưu từ** (*Map Save ≠ Word Save*): hai hành động riêng; lưu bản đồ
  không phải lưu từ vựng; lưu bản đồ không thể bị đánh đồng với lưu từ.
- Giữ **định danh từ vựng chuẩn** và tham chiếu *sense/nghĩa* khi áp dụng.

### Lĩnh vực 2 — Vocabulary Library & Word Profile (Thư viện & Hồ sơ từ)

- **Một hồ sơ cho mỗi mục từ vựng**, hỗ trợ **nhiều nghĩa (multiple senses)**.
- Loại mục được hỗ trợ: **từ đơn, cụm từ, thành ngữ (idiom), phrasal verb, mẫu biểu
  đạt (expression pattern)**.
- **Collections, Tags, Filters.**
- **Quick Profile** (bắt/tổng hợp nhẹ, nhanh) và **Full Profile** (đầy đủ khi cần).
- **Làm giàu bằng AI khi người dùng yêu cầu** (*on demand*), không buộc sinh mọi chi
  tiết ngay lập tức.
- Nếu AI làm giàu chưa đủ: **cho phép hồ sơ tối giản** và **ghi rõ phần nào còn phải
  soát lại**.
- **Giữ chỉnh sửa của người dùng** và dữ liệu từ vựng hiện có khi làm giàu/cập nhật.
- Giữ tách bốn khái niệm: **định danh từ vựng · từng nghĩa riêng · ngữ cảnh nguồn ·
  bằng chứng học**.
- Triết lý: Library không phải bãi chứa mọi từ AI từng sinh ra; gợi ý AI, nội dung
  tạm, từ đã lưu và bằng chứng thành thạo là **bốn trạng thái khác nhau**.

### Lĩnh vực 3 — Discovery and Input (Khám phá & Nhập)

**Sáu hướng — tất cả đã duyệt:**

1. **Text Discovery** — giải thích từ/biểu đạt được chọn **trong đúng ngữ cảnh thật
   của nó**.
2. **Reading Workspace** — đọc dài hơi để khám phá từ mà không mất trải nghiệm đọc.
3. **Listening Discovery** — khám phá từ **lấy âm thanh làm trục** từ vật liệu nghe.
4. **Quick Capture** — bắt từ/biểu đạt nhanh, gián đoạn tối thiểu.
5. **AI-generated Discovery Content** — sinh nội dung học hữu ích, gồm nội dung dựa
   trên từ đã lưu hoặc một nhóm từ đã chọn.
6. **External Content Import** — đưa nội dung ngoài vào: văn bản, tài liệu, nội dung
   web, âm thanh, video, transcript — **nơi được hỗ trợ kỹ thuật và được cấp phép
   thích đáng**.

**Yêu cầu sản phẩm:**

- Khi đọc dài: lưu ngay hoặc **đánh dấu để sau** (*Mark for Later*) — hai khái niệm
  tách bạch với lưu vào Library.
- Giữ ngữ cảnh gốc **có chọn lọc** khi hữu ích, tôn trọng quyền kiểm soát của người
  dùng và ràng buộc của nguồn.
- AI giải thích **mục được chọn + ngữ cảnh liên quan**, không biến mọi tương tác
  thành phân tích cả nguồn.
- Listening Discovery phải **thực sự thiên về âm thanh**, không biến thành tính năng
  chỉ vì văn bản dễ xử lý hơn.
- Ngữ cảnh học sinh ra khi cần — **không bắt buộc lưu vĩnh viễn mọi ví dụ/sửa đã sinh**.
- Import ngoài phải tôn trọng **phép, bảo mật, quyền riêng giới hạn kỹ thuật**.
- **Không quảng bá hỗ trợ định dạng nội dung trừ khi kho mã chứng minh được.**

### Lĩnh vực 4 — Learning Intelligence (Trí tuệ học tập)

Diễn giải bằng chứng về mức người học biết và việc nên làm tiếp theo. **Bốn chiều đã
duyệt:**

1. **Recognition** — nhận diện từ và nghĩa.
2. **Recall** — gọi lại từ khỏi trí nhớ.
3. **Usage** — dùng từ phù hợp trong ngữ cảnh.
4. **Flexibility** — dùng từ qua nhiều ngữ cảnh, tình huống khác nhau.

Năng lực kèm theo đã duyệt:

- **Error Log** — nhật ký lỗi, **sửa được các lỗi đã ghi**.
- Đánh giá độ tự tin **tùy chọn / có chọn lọc** (*optional or selective confidence*).
- **Gợi ý học theo hướng AI-first**, với điều chỉnh tự động **giới hạn và có kiểm
  soát**.
- **Suggested learning paths** và **Self-directed learning paths**.
- **Session Insights**, **Progress reporting**, **Vocabulary Coverage**.

Ràng buộc quan trọng:

- Bốn chiều là **mô tả bằng chứng học**, **không** ngụ ý bốn lịch FSRS riêng.
- **Phơi nhiễm, thời gian mở trang, vào Focus Mode không tự coi là bằng chứng
  thành thạo.** Mastery cần bằng chứng có ý nghĩa.
- Gợi ý phải **giải thích được** và **giới hạn hợp lý**.
- Khuyến nghị AI **không được lặng lẽ ưu tiên hóa thay người dùng** hay đổi cài đặt
  quan trọng khi chưa được phép.
- **Giữ nguyên ranh giới Review, FSRS, Undo, Practice hiện tại** trừ khi PO duyệt đổi.
- **Không thiết kế lại scheduler hiện có** chỉ để sản phẩm "trông thông minh hơn".

### Lĩnh vực 5 — Learning Experience (Trải nghiệm học tập)

Kết nối các năng lực thành hành trình học mạch lạc.

- **Điều hướng đã duyệt:** `Learn` · `Discover` · `Vocabulary` · `Progress`.
- **Trang chủ đã duyệt:** `Continue` · `Quick Actions`.
- **Hướng phiên học đã duyệt:** Quick sessions · Planned sessions · **AI Suggested
  sessions**.
- Năng lực kèm theo: **Focus Study**, **Focus Test**, **Pomodoro (tùy chọn)**, sự
  kiện **rời tab giới hạn và có ý thức quyền riêng tư** (không phạt điểm chỉ vì rời
  tab), **Daily Goals (tùy chọn)**, **Session Report**.
- Nguyên tắc: người học **tiếp tục mà không phải dựng lại** quy trình trước; phiên
  có thể **kết hợp nhiều hoạt động**; phiên phải có **ý định rõ ràng và kết luận hữu
  ích**; trải nghiệm **không ép đi tuần tự mọi tính năng**; đường học và gợi ý phiên
  phải tính đến **từ vựng sẵn có, nhu cầu hiện tại, tùy chọn** của người dùng.
- **Giữ gìn Review, Practice, Exam hiện có**; Practice là **lĩnh vực riêng**, không
  được hấp thụ hay viết lại thiếu phê duyệt.

### Lĩnh vực 6 — Standardization & Ecosystem Integration (Chuẩn hóa & Hợp nhất)

Flashcards phải hoạt động như **một hệ sinh thái mạch lạc** với ranh giới trách
nghiệm rõ.

- **Library** lưu và tổ chức từ đã giữ. **Word Profile** mô tả mục từ và các nghĩa.
  **Maps** kết nối từ và tri thức. **Discovery** cung cấp cuộc gặp từ mới và cơ hội
  học theo ngữ cảnh. **Review & Practice** đánh giá và luyện tập theo trách nhiệm
  sẵn có. **Learning Intelligence** diễn giải bằng chứng và gợi ý bước tiếp.
  **Sessions** điều phối hoạt động. **Reports** tổng hợp kết quả. **Home** giúp điều
  hướng và tiếp tục.
- Các khu vực chức năng **dùng chung dữ liệu nhất quán** và nối qua **hành trình người
  dùng có ý nghĩa**.
- **Tránh nhiều nguồn sự thật (source of truth) trùng lặp** cho cùng một thông tin.
- Giữ **tương thích trang web hiện có** và các năng lực giá trị.
- Cải thiện **từng bước**; trách nhiệm **rõ ràng để agent tương lai không dựng lại
  thứ đã có**.
- Ưu tiên **kết quả học tập đầu-cuối** hơn đếm tính năng rời rạc.

## 7. Trách nhiệm liên miền & tích hợp

| Khối | Trách nhiệm duy nhất | Không thuộc về khối này |
| --- | --- | --- |
| **Library** | Lưu & tổ chức từ đã chọn giữ | Không phải nơi chứa gợi ý AI chưa chọn |
| **Word Profile** | Mô tả một mục từ và các nghĩa của nó | Không phải lịch học, không phải bằng chứng thành thạo |
| **Maps** | Kết nối từ & tri thức | Lưu bản đồ không tạo từ; mở rộng không ghi lịch |
| **Discovery** | Cung cấp cuộc gặp từ mới + ngữ cảnh | Không tự lưu; không đánh giá |
| **Review & Practice** | Đánh giá & luyện tập theo trách nhiệm hiện có | Không bị hấp thụ bởi khối khác |
| **Learning Intelligence** | Diễn giải bằng chứng, gợi ý bước tiếp | Không tự đổi cài đặt/quyền ưu tiên người dùng |
| **Sessions** | Điều phối hoạt động học | Không phải kho lưu trữ |
| **Reports** | Tổng hợp kết quả & thông tin chi tiết | Không phải nguồn sự thật gốc |
| **Home** | Giúp điều hướng & tiếp tục học | Không phải trang thống kê thay Reports |

Quy tắc tích hợp: dùng chung dữ liệu nhất quán; không nhân bản nguồn sự thật; các
hành trình phải nối Discovery → Vocabulary → Maps → hoạt động học → Progress một
cách liền mạch.

## 8. Quy tắc & phân biệt sản phẩm then chốt

Đây là **quy tắc tường minh**, không phải gợi ý:

1. **Seen ≠ Saved ≠ Mastered** (đã thấy ≠ đã lưu ≠ đã thành thạo).
2. **Lưu bản đồ ≠ lưu từ vựng** (*Map Save ≠ Word Save*).
3. **Gợi ý của AI không tự thành từ vựng đã lưu.**
4. **Tôn trọng từ người dùng chọn và chỉnh sửa của họ.**
5. **Một mục từ có thể có nhiều nghĩa** (multiple senses — tách bạch từng nghĩa).
6. **Bằng chứng học không được đánh đồng với việc chỉ phơi nhiễm hay hoạt động.**
7. Ưu tiên học **phong phú ngữ cảnh**, không chỉ ghi nhớ từ lẻ.
8. **Người học không cần dùng mọi tính năng cho mọi từ** — con đường học linh hoạt.
9. **AI hữu ích nhưng không phải phụ thuộc bắt buộc** của toàn ứng dụng.
10. **Giữ nguyên năng lực hiện có** trừ khi có phê duyệt đổi rõ ràng.
11. **Ưu tiên tiến hóa tăng dần** thay vì dựng lại.
12. Quyết định phải cân nhắc: giá trị học tập, UX, độ tin cậy, phụ thuộc, chi phí, rủi ro.
13. **Phân biệt tri thức bền vững của người dùng với nội dung sinh tạm.**
14. **Tôn trọng quyền kiểm soát và quyền riêng tư** trong capture, import, giữ ngữ
    cảnh và theo dõi focus.

## 9. Thứ tự ưu tiên & lộ trình cấp cao

**Thứ tự ưu tiên sản phẩm đã duyệt (thứ tự ưu tiên — không phải cam kết mọi tính
năng hoàn thành hay mọi giai đoạn tự độc lập được):**

1. **Nền tảng từ vựng & toàn vẹn dữ liệu** (*Vocabulary foundation & data integrity*).
2. **Vocabulary Maps & Discovery/Input**.
3. **Learning Intelligence**.
4. **Learning Experience & điều phối phiên học**.
5. **Tích hợp liên miền, kiểm thử chất lượng & xác minh phát hành**.

> **Giai đoạn lớn kế tiếp theo lộ trình: Learning Intelligence**, kế tiếp là
> Learning Experience — với điều kiện các khoảng trống/phụ thuộc ở §11 được xử lý.

### Giai đoạn A — Hoàn tất & xác minh hai lĩnh vực đã làm (ưu tiên 1–2, đang ở cuối đường)

| Mục | Nội dung |
| --- | --- |
| **Mục đích** | Đưa Foundation, Maps và Discovery từ "báo cáo PASS cục bộ" thành trạng thái sẵn sàng chấp nhận thực tế. |
| **Năng lực sản phẩm** | Không thêm tính năng mới:_maps 8 trải nghiệm, Discovery 6 hướng đã được báo cáo làm xong; phần còn lại là xác minh. |
| **Phụ thuộc** | Quyền của PO cho migration hosted; môi trường trình duyệt thật; kiểm tra đối chiếu từng yêu cầu Maps/Discovery. |
| **Giá trị cho người dùng** | Hai lĩnh vực lớn thực sự dùng được trên môi trường thật. |
| **Rủi ro / câu hỏi** | hosted Supabase chưa xác minh (v13–v19); trình duyệt thật chưa xác minh (audio, cuộn, đồ thị); một hướng Discovery chỉ hỗ trợ một phần (§11). |
| **Điều kiện nghiệm thu** | Migration hosted chạy & verify xong; xác minh trình duyệt thật; đối chiếu đầy đủ 8 yêu cầu Maps và 6 hướng Discovery với bằng chứng cụ thể. |

### Giai đoạn B — Learning Intelligence (ưu tiên 3, **giai đoạn lớn kế tiếp**)

| Mục | Nội dung |
| --- | --- |
| **Mục đích** | Biến dữ kiện học thành **diễn giải và gợi ý có thể tin**: người học biết mình mạnh/yếu ở đâu, lỗi lặp nào, bước tiếp theo nên làm gì. |
| **Năng lực sản phẩm (đã duyệt)** | Bốn chiều Recognition/Recall/Usage/Flexibility; Error Log sửa được; confidence tùy chọn/chọn lọc; gợi ý AI-first có kiểm soát; Suggested & Self-directed paths; Session Insights; Progress reporting; Vocabulary Coverage. |
| **Phụ thuộc** | Bằng chứng học ổn định từ Review/Practice/Exam hiện có; nền tảng dữ liệu đã xác minh (Giai đoạn A); quyết định PO về mức độ AI-first. |
| **Giá trị cho người dùng** | Học có hướng, lỗi được nhận diện và xử lý, tiến độ được giải thích thay vì chỉ đếm. |
| **Rủi ro / câu hỏi** | Không được thiết kế lại FSRS/scheduler; không được coi phơi nhiễm là mastery; gợi ý phải giải thích được và không âm thầm đổi cài đặt; phạm vi Error Log vs. Weak words hiện có cần làm rõ. |
| **Điều kiện nghiệm thu** | Khẳng định "giữ ranh giới Review/FSRS/Undo/Practice" được kiểm chứng bằng kiểm thử hồi quy; mọi gợi ý có cơ chế giải thích và đồng ý người dùng; không có tự điều chỉnh ngoài phạm vi được duyệt. |

### Giai đoạn C — Learning Experience & điều phối phiên (ưu tiên 4)

| Mục | Nội dung |
| --- | --- |
| **Mục đích** | Gói năng lực thành hành trình học: vào là tiếp tục được ngay, mỗi phiên có ý định và kết luận. |
| **Năng lực sản phẩm (đã duyệt)** | Điều hướng Learn/Discover/Vocabulary/Progress; Home = Continue + Quick Actions; Quick/Planned/AI Suggested sessions; Focus Study & Focus Test; Pomodoro tùy chọn; sự kiện rời tab có giới hạn & quyền riêng tư; Daily Goals tùy chọn; Session Report. |
| **Phụ thuộc** | Learning Intelligence (gợi ý phiên); dữ liệu từ Maps/Discovery/Library sẵn có; quyết định PO về cấu trúc điều hướng mới. |
| **Giá trị cho người dùng** | Giảm ma sát quay lại học; phiên ngắn gọn, có mục tiêu; không mất bối cảnh. |
| **Rủi ro / câu hỏi** | Cấu trúc điều hướng 4 mục chưa tồn tại trong repo (§11, OPEN DECISION); không được hấp thụ Practice; Pomodoro/chỉ rời tab phải tinh tế về quyền riêng tư. |
| **Điều kiện nghiệm thu** | Hành trình Resume/Continue hoạt động đầu-cuối; các phiên kết hợp hoạt động mà không ép tuần tự; Review/Practice/Exam cũ giữ nguyên. |

### Giai đoạn D — Tích hợp liên miền, QA & xác minh phát hành (ưu tiên 5)

| Mục | Nội dung |
| --- | --- |
| **Mục đích** | Đảm bảo sáu khối hoạt động như một hệ sinh thái: dùng chung dữ liệu, không trùng nguồn sự thật, không hồi quy. |
| **Năng lực sản phẩm** | Hành trình liên miền (Discovery → Library → Maps → Practice → Progress); đối soát tài liệu; bộ kiểm thử hồi quy mở rộng. |
| **Phụ thuộc** | Giai đoạn B & C. |
| **Giá trị cho người dùng** | Trải nghiệm nhất quán, tin cậy; ít tính năng rời rạc. |
| **Rủi ro / câu hỏi** | Nhu cầu xác minh hosted + trình duyệt thật kéo dài xuyên suốt; tài liệu cũ (upgrade-plan) là lịch sử — tránh sửa lách mãnh. |
| **Điều kiện nghiệm thu** | Toàn bộ gate chất lượng xanh trên môi trường mục tiêu; đối chiếu tài liệu; báo cáo phân biệt rõ verified/unverified. |

## 10. Trạng thái triển khai hiện tại & bằng chứng

**Cơ sở bằng chứng của tài liệu này (tác vụ FC-DOC-016, chỉ đọc):** liệt kê tệp
(`git status`, `docs/`, báo cáo gốc kho), đọc toàn văn `FC-SEC-013-REPORT.md`,
`FC-MAPS-014-REPORT.md`, `FC-DISC-015-REPORT.md`, đếm migration v1–v19 trong
`supabase/migrations/`, đối chiếu tệp nguồn (`MapsPage`, `DiscoverPage`,
`shared/discovery.ts`, `FocusTimer`, `DashboardPage`…). **Tác vụ này không chạy
test, không chạy trình duyệt, không chạm môi trường hosted.** Báo cáo PASS của các
workstream trước là **REPORTED IMPLEMENTED** — không phải xác minh độc lập.

### Bảng trạng thái tổng hợp

| Lĩnh vực / workstream | Kết quả dự kiến | Trạng thái | Nguồn bằng chứng | Khoảng trống còn lại | Hành động tiếp |
| --- | --- | --- | --- | --- | --- |
| **Foundation & data integrity** (FC-VERIFY-006, FC-HARDEN-007, FC-RC-FIX-009, FC-RC-FIX-011, FC-RELEASE-012) | Dữ liệu từ vựng toàn vẹn, cửa sổ phát hành cục bộ an toàn | **REPORTED IMPLEMENTED** + **REPO CONFIRMED** (báo cáo tồn tại; migration v13–v17 có trong kho) | 5 báo cáo gốc kho; `supabase/migrations/` | hosted UNVERIFIED | Chuẩn bị migration hosted khi PO duyệt |
| **Bảo mật sense recovery** (FC-SEC-013, schema 17) | Ranh giới phục hồi sense an toàn | **REPORTED IMPLEMENTED** — báo cáo ghi "SECURITY GATE PASSED" trên PG cục bộ; hosted **UNVERIFIED** (báo cáo ghi rõ) | `FC-SEC-013-REPORT.md` | PostgREST/hosted path chưa chạy thật | Xác minh hosted (cùng điều kiện PO) |
| **Vocabulary Maps** (FC-MAPS-014, schema 18) | 8 trải nghiệm bản đồ + tích hợp Library | **REPORTED IMPLEMENTED**: PASS, 88 file / **1908 passed / 3 skip có sẵn**, pg-release 53/53 (đọc từ báo cáo); **REPO CONFIRMED**: `20261027090000_vocabulary_maps.sql`, `src/pages/MapsPage.tsx`, `src/components/maps/`, `shared/vocab-map.ts`, `docs/vocabulary-maps.md`, 3 suite test Maps | `FC-MAPS-014-REPORT.md` + tệp repo | hosted UNVERIFIED; trình duyệt thật UNVERIFIED; **đối chiếu đầy đủ từng mục yêu cầu 8 hướng chưa làm lại trong tác vụ này** | Đối chiếu chi tiết yêu cầu → tạo danh sách cần xác minh trình duyệt |
| **Discovery & Input** (FC-DISC-015, schema 19) | 6 hướng khám phá & nhập | **REPORTED IMPLEMENTED**: PASS; **1990 passed / 3 skip có sẵn / 93 file**, pg-release 53/53 (đọc từ `FC-DISC-015-REPORT.md`); **REPO CONFIRMED**: `20261028090000_discovery.sql`, `src/pages/DiscoverPage.tsx`, `src/components/discovery/`, `shared/discovery.ts`, `docs/discovery.md`, 4 suite server + 1 suite client | `FC-DISC-015-REPORT.md` + tệp repo | hosted UNVERIFIED (v19); trình duyệt thật UNVERIFIED (audio, cuộn, đọc to); import âm thanh/tài liệu một phần — xem §11 | Xác minh hosted + trình duyệt; rà đối chiếu 6 hướng |
| **Learning Intelligence** | 4 chiều + Error Log + gợi ý có kiểm soát | **NOT STARTED** (phần lớn). Có sẵn lân cận: confidence (migration v5, v9), Weak words, Exam plan (AI, dạng gợi ý có duyệt), Progress charts, `mastery` | Greps repo: không có "Error Log"/"Session Insights"/"Vocabulary Coverage"/"learning path" trong `src/` | Toàn bộ phạm vi đã duyệt ở §6 Lĩnh vực 4 | Chuẩn bị spec cho giai đoạn B |
| **Learning Experience** | Điều hướng 4 mục, Continue/Quick Actions, phiên học | **PARTIAL**. Có: Dashboard + TodayPlan + Daily Goal (v5), Focus mode + FocusTimer trên Review/Practice, session summary/undo (v2), Exam có đồng hồ. Chưa: cấu trúc Learn/Discover/Vocabulary/Progress, Continue/Quick Actions, Quick/Planned/AI Suggested sessions, Focus Test, Pomodoro, rời tab theo dõi, Session Report dạng mới | `DashboardPage`, `FocusTimer`, `ReviewPage`, `PracticePage`; greps không khớp "Continue"/"Quick action"/"Pomodoro" (chỉ có trong `upgrade-plan.md` là ghi chú kế hoạch) | Thiết kế điều hướng + phiên = quyết định PO | Đề xuất phương án điều hướng (OPEN DECISION) |
| **Chuẩn hóa & hợp nhất** | Một hệ sinh thái, ít nguồn sự thật trùng | **PARTIAL** — các workstream dùng chung contract `shared/*`, pattern API/UX nhất quán; chưa có audit liên miền đầy đủ | Quan sát cấu trúc repo | Chưa có đối soát "trùng nguồn sự thật" chính thức | Giai đoạn D |

**Ghi chú bằng chứng:**

- Các con số test (**1908**, **1990**, **53**, số skip) được **đọc lại từ tệp báo cáo
  trong kho**, khớp đúng với brief cung cấp — chúng là số **do workstream báo cáo**,
  chưa được chạy lại trong tác vụ này.
- Mốc git: nhánh `newfeature` @ `8d76720`; trước khi viết tài liệu này working tree
  có **93 entry chưa commit** (39 modified + 54 untracked) — khớp con số 93 mà
  `FC-DISC-015-REPORT.md` ghi. (`FC-MAPS-014` ghi mốc 73 entry thời điểm của nó —
  chỉ là khác biệt snapshot theo thời gian, **không phải mâu thuẫn**.)
- **Chưa có workstream nào xác minh hosted Supabase hay trình duyệt thật** — cả ba
  báo cáo lớn đều ghi UNVERIFIED cho hai mục này.

## 11. Khoảng trống, rủi ro & phần chưa xác minh

Danh sách ưu tiên (không tự biến câu hỏi thành yêu cầu; thiếu bằng chứng = UNVERIFIED,
không phải lỗi):

| # | Vấn đề | Loại | Ưu tiên |
| --- | --- | --- | --- |
| 1 | **Migration & bảo mật hosted Supabase (v13–v19)** chưa từng chạy/verify trên hosted — cần quyền PO cho migration từ xa | UNVERIFIED | Cao — điều kiện của mọi "sẵn sàng production" |
| 2 | **Xác minh trình duyệt thật**: Discovery (audio phát được?, tua, đọc to, cuộn khôi phục vị trí) và Maps (đồ thị hiển thị, zoom/pan, bàn phím) | UNVERIFIED | Cao |
| 3 | **6 hướng Discovery có chạy đầu-cuối hay chỉ có lối vào UI?** — báo cáo có test journeys A–J nhưng chưa đối chiếu từng hướng với yêu cầu gốc | UNVERIFIED (cần đối chiếu) | Cao |
| 4 | **Import ngoài chưa khớp đầy đủ định dạng đã duyệt**: PDF/Office không đọc (giới hạn có ghi rõ), **âm thanh/tệp video chưa được nhập** (audio chỉ phát qua URL trong phiên; không có upload/transcribe). Yêu cầu gốc nói "nơi được hỗ trợ kỹ thuật" nên đây là **PARTIAL**, cần PO xác nhận chấp nhận giới hạn | PARTIAL / OPEN DECISION | Trung bình |
| 5 | **Đối chiếu đầy đủ 8 yêu cầu Maps** (ví dụ mức độ "clusters & giải thích khác biệt" từng hướng) chưa làm lại độc lập | UNVERIFIED | Trung bình |
| 6 | **Learning Intelligence**: chưa có spec chi tiết; phạm vi Error Log vs. Weak words hiện có cần làm rõ; phụ thuộc bằng chứng học từ giai đoạn A | NOT STARTED / OPEN DECISION | Trung bình — nhưng là **giai đoạn lớn kế tiếp** |
| 7 | **Learning Experience**: cấu trúc điều hướng đã duyệt (Learn/Discover/Vocabulary/Progress) **khác cấu trúc sidebar hiện tại** — tách lại nav là quyết định kiến trúc sản phẩm của PO | OPEN DECISION | Trung bình |
| 8 | **Chưa có mục tiêu định lượng được duyệt** (retention, engagement…) — không tự bịa; ghi nhận là quyết định đo lường tương lai | OPEN DECISION | Thấp |
| 9 | **Tài liệu cũ là lịch sử**: `docs/upgrade-plan.md` mô tả các phase đã qua và các ghi chú kế hoạch (vd. Pomodoro) — không phải cam kết hiện hành | Ghi chú | Thấp |
| 10 | Tương thích/tài liệu: README và docs hiện có đã cập nhật cho Maps/Discovery (**REPO CONFIRMED**); chưa có audit liên miền cho các tài liệu cũ hơn | PARTIAL | Thấp |

Không phát hiện lỗi sản phẩm nào trong tác vụ này vì không có bằng chứng chạy thật —
mọi thiếu hụt ở trên là **thiếu bằng chứng xác minh**, không phải defect.

## 12. Mục tiêu không phải (Non-goals) & ranh giới phê duyệt

- **Không** xây dựng lại ứng dụng từ đầu.
- **Không** thay thế hoặc thiết kế lại hành vi **Review/FSRS/Undo/Practice** khi chưa
  có phê duyệt rõ ràng của PO.
- **Không** đưa vào dịch vụ AI trả phí hay dependency trả phí khi chưa được duyệt.
- **Không** truy cập/sửa hệ thống production/staging đã host khi chưa được duyệt.
- **Không** chạy migration trên cơ sở dữ liệu từ xa khi chưa được duyệt.
- **Không** deploy, push hoặc thao tác Git phá hủy khi chưa được ủy quyền.
- **Không** giả định các phạm vi chưa được duyệt là kế hoạch hiện tại: ứng dụng di
  động mới, OCR, tích hợp bên thứ ba, v.v.
- **Không** âm thầm mở rộng phạm vi sản phẩm chỉ vì một công cụ/agent *có thể* làm
  thêm tính năng.
- **Không** biến AI thành yêu cầu bắt buộc để ứng dụng dùng được ở mức cơ bản.

## 13. Quyền sở hữu sản phẩm & quy trình làm việc của AI-agent

- **Người dùng = Product Owner**, người ra quyết định cuối cùng.
- **ChatGPT = AI Engineering Manager / Technical Lead**: soi bằng chứng, đặt tác vụ
  có ranh giới, chuẩn bị tác vụ kế tiếp.
- **OpenCode = coding agent** thực thi tác vụ trong kho.
- Không giả định sự thật về codebase khi chưa có bằng chứng từ kho.
- Không công nhận nghiệm thu chỉ vì một agent nói "xong".
- Quy trình ưu tiên: `DISCOVERY → SPECIFICATION → APPROVAL → IMPLEMENTATION →
  VERIFICATION → REVIEW → ACCEPTANCE`.
- Cách thực thi ưu tiên: **Large Task, Controlled Execution** — tác vụ lớn nhưng có
  ranh giới, gồm triển khai + test + tự sửa + **một báo cáo cuối duy nhất**, thay vì
  báo cáo trung gian liên tục.
- **Cổng phê duyệt bắt buộc** giữ nguyên cho: thay đổi production/staging, migration
  rủi ro, thao tác dữ liệu phá hủy, thay đổi kiến trúc lớn, dịch vụ trả phí, thông
  tin xác thực, thay đổi toàn cục/hệ thống, Git không được ủy quyền.
- **PO giữ thẩm quyền nghiệm thu cuối cùng.**

> Đây là cách **quản lý sản phẩm**, không phải tính năng hướng người dùng.

## 14. Tiêu chí thành công & quyết định đo lường tương lai

### Kết quả học tập
Xem §3 — dùng được từ trong ngữ cảnh; cải thiện trên 4 chiều; nhận diện lỗi lặp; nối
tri thức; tiến độ dài hạn thay vì đếm hoạt động.

### Trải nghiệm người dùng
- Khám phá và bắt từ vựng tiện lợi.
- Di chuyển giữa Discovery, Vocabulary, Maps, hoạt động học và Progress mà không đứt
  quãng.
- **Lưu / đánh dấu để sau / sinh nội dung** có nghĩa rõ ràng và khác biệt.
- Người dùng giữ quyền kiểm soát: lưu gì, đi đường học nào.
- Ứng dụng hữu ích **không cần AI cho mọi hành động**.

### Độ tin cậy & niềm tin
- Năng lực hiện có tương thích, không hồi quy.
- Từ vựng và bằng chứng học nhất quán.
- Lỗi AI không chặn các luồng công việc cơ bản.
- Bảo mật, toàn vẹn dữ liệu, quyền riêng tư là nền tảng.
- Báo cáo **phân biệt kết quả đã xác minh với giả định chưa xác minh**.

### Quyết định đo lường tương lai (OPEN DECISION, chờ PO)
- Chưa có mục tiêu định lượng nào được duyệt (tỷ lệ retention, engagement, v.v.).
  **Không bịa chỉ số.** Khi cần, PO duyệt bộ chỉ số và ngưỡng trước khi biến nó thành
  tiêu chí nghiệm thu. Có thể tham khảo `docs/metrics.md` cho các chỉ số hiện có.

## 15. Lịch sử thay đổi & ghi chú nguồn/bằng chứng

### Lịch sử thay đổi

| Phiên bản | Ngày | Nội dung | Người lập |
| --- | --- | --- | --- |
| V1.0 | 2026-10-20 | Bản tổng hợp đầu tiên: 6 lĩnh vực, 14 quy tắc, lộ trình 5 ưu tiên, trạng thái theo bằng chứng, ranh giới phê duyệt | OpenCode (tác vụ FC-DOC-016) dưới sự quản lý của Technical Lead; PO giữ quyết định cuối |

### Nguồn đã dùng (evidence notes)

| Nguồn | Loại | Dùng để |
| --- | --- | --- |
| Brief FC-DOC-016 (Blueprint V1.0, quyết định PO) | APPROVED REQUIREMENT | §3–§9, §12–§14 |
| `FC-DISC-015-REPORT.md` | Báo cáo workstream | Trạng thái Discovery, số test 1990/93/53, UNVERIFIED |
| `FC-MAPS-014-REPORT.md` | Báo cáo workstream | Trạng thái Maps, số test 1908/88, journey A–I |
| `FC-SEC-013-REPORT.md` | Báo cáo workstream | Biên bảo mật sense recovery, hosted UNVERIFIED |
| `FC-VERIFY-006`, `FC-HARDEN-007`, `FC-RC-FIX-009/011`, `FC-RELEASE-012`, `FC-RC-008/010` (zip) | Báo cáo/gói review | Giai đoạn nền tảng & phát hành |
| `supabase/migrations/` (v1–v19) | REPO CONFIRMED | Danh sách version có thật trong kho |
| `docs/discovery.md`, `docs/vocabulary-maps.md`, `docs/ai-features.md`, `docs/supabase-schema.md`, `docs/review-logic.md`, `docs/upgrade-plan.md`, `docs/metrics.md`, `README.md` | Tài liệu hiện có | Đối chiếu mô tả năng lực |
| Tệp nguồn `src/pages/MapsPage.tsx`, `DiscoverPage.tsx`, `DashboardPage.tsx`, `FocusTimer.tsx`, `shared/*` | REPO CONFIRMED | Đối chiếu tồn tại tính năng |

### Các điểm khác biệt đã ghi nhận (không tự xử lý ngầm)

1. **Điều hướng đã duyệt** (`Learn/Discover/Vocabulary/Progress`, Home
   `Continue/Quick Actions`) **không khớp** cấu trúc điều hướng hiện tại trong repo
   → giữ nguyên yêu cầu đã duyệt, ghi **OPEN DECISION** chờ PO (§11 #7).
2. **Discovery import**: yêu cầu duyệt nêu "audio/video … nơi được hỗ trợ kỹ thuật";
   repo hiện chưa hỗ trợ nhập tệp âm thanh/video và PDF → giữ yêu cầu, ghi **PARTIAL**
   (§11 #4).
3. **Số liệu test khác nhau giữa các báo cáo** (1908 vs 1990) là snapshot theo thời
   điểm các workstream — không phải mâu thuẫn.
4. Báo cáo workstream được tin ở mức **REPORTED IMPLEMENTED**; không có workstream nào
   xác minh hosted/ trình duyệt thật → hai mục đó **UNVERIFIED** trên toàn tài liệu.

### Liên kết tài liệu liên quan (không sửa các tệp này trong tác vụ này)

- [`discovery.md`](discovery.md) · [`vocabulary-maps.md`](vocabulary-maps.md) ·
  [`ai-features.md`](ai-features.md) · [`supabase-schema.md`](supabase-schema.md) ·
  [`review-logic.md`](review-logic.md) · [`metrics.md`](metrics.md) ·
  [`import-and-export.md`](import-and-export.md) ·
  [`upgrade-plan.md`](upgrade-plan.md) (lịch sử) · [`README.md`](../README.md)
- Báo cáo gốc kho: [`FC-DISC-015-REPORT.md`](../FC-DISC-015-REPORT.md),
  [`FC-MAPS-014-REPORT.md`](../FC-MAPS-014-REPORT.md),
  [`FC-SEC-013-REPORT.md`](../FC-SEC-013-REPORT.md) và các báo cáo `FC-*` còn lại.
