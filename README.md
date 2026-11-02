# Alcove Accounts Workflow Portal

Accounts टीम की Daily / Weekly / Monthly / Yearly checklist पर बना online portal।
हर काम समय पर हुआ या नहीं (Timeliness) और सही था या नहीं (First-time-right), दोनों dashboard पर दिखते हैं।
Challan या Acknowledgement की PDF upload होते ही उसकी details अपने-आप Attachment Register में भर जाती हैं।

---

## 1. Portal में क्या है

| Screen | कौन देखेगा | क्या मिलेगा |
|---|---|---|
| **Dashboard** | Admin (पूरी team), बाकी लोग (खुद और अपनी team) | Due, On-time %, Late, Overdue, Awaiting approval, First-time-right %। Person-wise, Reporting head-wise, Company-wise और Category-wise tables, daily trend और overdue list |
| **Tasks / My Tasks** | सभी | Overdue, Due today, Upcoming, Sent back, Awaiting approval और Done वाले tabs। Task खोलें, proof upload करें, details जाँचें, Submit करें |
| **Approvals** | Admin | Submit हुए compliance tasks: reference no, amount, period और PDF। Approve या Send back (कारण के साथ) करें, bulk approve भी हो सकता है |
| **Compliance Matrix** | Admin | Company × (GST, TDS/TCS, PF/ESI, ROC, Income Tax, Audit), महीने के हिसाब से हरा, पीला या लाल। "⚠ no task" बताता है कि compliance लागू है पर किसी को assign नहीं हुआ |
| **Attachment Register** | सभी (अपना) / Admin (सब) | Upload की गई हर PDF से निकली details: Doc type, ARN / Ack / Challan / SRN / TRRN / CPIN, Amount, Date, Period, FY/AY, GSTIN/PAN/TAN। Excel (CSV) में download हो सकती है |
| **Task Master** | Admin | Checklist CSV import/export (वही format), Approval flag on/off, Category बदलना, task हटाना, Ad-hoc task assign करना, Go-live date |
| **Users** | Admin | Login IDs, e-mail, role, password reset, e-mail digest |

### काम कैसे चलता है
1. Checklist से हर दिन के tasks अपने-आप बनते हैं। Daily task Mon–Sat बनता है, समय "Daily Time" से लिया जाता है। Weekly task tick किए हुए दिन पर बनता है। Monthly task "Due Day(s)" पर बनता है (31 वाली तारीख छोटे महीने में आखिरी दिन पर आ जाती है)। Yearly task महीने वाले column की तारीख पर बनता है।
2. Doer task खोलकर PDF upload करता है। Portal PDF पढ़कर ARN, Amount, Period वगैरह भर देता है। Doer उन्हें जाँचकर Submit करता है।
3. अगर document किसी दूसरी company का निकला, तो portal चेतावनी देता है।
4. **Approval:** GST, TDS/TCS, PF/ESI, ROC, Income Tax और Audit वाले tasks डिफ़ॉल्ट रूप से नीरज जी के approval में जाते हैं। बाकी routine tasks Submit होते ही Done मान लिए जाते हैं। यह flag Task Master में बदला जा सकता है।
5. Proof upload ज़रूरी है उन सभी tasks के लिए जिन्हें approval चाहिए (`.env` में `PROOF_REQUIRED_FOR=all` करने पर हर task के लिए)। जिन routine tasks में proof ज़रूरी नहीं है, उन्हें एक साथ select करके "Done" किया जा सकता है।
6. **Timeliness** = Submit का समय ≤ Due समय। **First-time-right** = approval में बिना वापस भेजे pass हुए tasks का प्रतिशत।
7. Send back हुआ task doer के "Sent back" tab में वापस आ जाता है।

### Login
- Checklist में जितने Doer और Reporting heads हैं, सबका user अपने-आप बन जाता है।
- **Username** पूरा नाम छोटे अक्षरों में, बीच में dot के साथ होता है, जैसे `niraj.goel`, `atriz.roy`, `kishore.kr.daga`। Users screen पर पूरी list है।
- **Team members:** login screen पर अपना नाम चुनें, password नहीं लगता।
- **Admin (Niraj Goel):** password `123456$$`, जिसे "Password" button से बदला जा सकता है।
- `Niraj Goel` = Admin।

---

## 2. चलाने का तरीका (Windows PC पर test)

1. Node.js **22 LTS या नया** install करें: https://nodejs.org
2. `start.bat` पर double-click करें। यह packages install करेगा, Downloads से checklist import करेगा और browser खोल देगा: http://localhost:3000
3. "Niraj Goel" चुनें और password `123456$$` से login करें।

Command line से:
```
cd "D:\claude project\alcove-workflow"
npm install
node scripts\import-csv.js "C:\Users\NIRAJ\Downloads\Import_File_Current_Tasks_02-11-2026.csv"
npm start
```

---

## 3. Alcove server पर deploy (IT team के लिए)

**Quick path (same server as employees.alcoverealty.in, which runs Caddy):**
1. DNS: add an `A` record `workflow.alcoverealty.in -> 98.130.91.176`.
2. Upload this folder (without `node_modules` and `data`) to the server and run `sudo bash deploy/install.sh`.
   It installs Node.js, creates the `alcoveflow` service user, imports `deploy/checklist.csv`, starts the systemd service on `127.0.0.1:3100` and schedules the 11 PM backup.
3. Append `deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. HTTPS is issued automatically.
4. Open https://workflow.alcoverealty.in, pick "Niraj Goel" and log in with `123456$$`.

Updates later: upload the new code and run `sudo bash deploy/install.sh` again (data and `.env` are kept).

**Generic notes:**

- **Requirements:** Node.js ≥ 22.13 (built-in `node:sqlite` is used, so nothing native has to be compiled). Works on Linux and Windows.
- **Steps:**
  1. Copy this folder to the server. Run `npm install --omit=dev`.
  2. Copy `.env.example` to `.env`. Set `PORT`, `GO_LIVE_DATE`, the SMTP settings and `PORTAL_URL`.
  3. Import the checklist once: `node scripts/import-csv.js /path/checklist.csv`. Later imports are done from the Task Master screen.
  4. Run it as a service, e.g. `pm2 start server.js --name alcove-workflow` (Linux) or NSSM / Task Scheduler (Windows).
  5. Put it behind HTTPS (nginx / IIS reverse proxy) when it is exposed on the internet.
- **Data:** everything is in `data/`: `workflow.db` (SQLite) and `uploads/` (PDFs). **Back up the `data/` folder daily.**
- **Time zone:** forced to Asia/Kolkata in `server.js`.

---

## 4. Checklist import के नियम
- File वही format में होनी चाहिए: "Job Checklist – Bulk Add / Delete Import" (Excel → Save As → CSV)।
- `Action` खाली हो तो task जुड़ता है या update होता है। `DELETE` लिखा हो तो task हट जाता है (पुराना history बना रहता है)।
- अगर "File is the full master" tick किया हो, तो file में जो task नहीं है वह हट जाएगा।
- Import करते समय नामों की spelling अपने-आप ठीक हो जाती है, जैसे "Natin Builders Pvt..Ltd.." → "Natin Builders Pvt. Ltd.", "Mall road" → "Mall Road", "Alcove Estates" → "Alcove Estate", "All -LOT" → "All - LOT"।
- Weekly वाले column में कोई भी निशान (✓, Y, ?) हो, उसे tick माना जाता है।

## 5. PDF पढ़ने की सीमाएँ
- GST, Income Tax, TRACES, EPFO, ESIC या MCA portal से download की गई PDF (जिनमें text होता है) सीधे पढ़ी जाती हैं।
- Scan की हुई PDF या photo में text नहीं होता। उनमें doer को details हाथ से भरनी होंगी, portal इसके लिए संदेश दिखा देता है।
- Phase 2 में scanned documents के लिए OCR या AI से पढ़ना जोड़ा जा सकता है।
