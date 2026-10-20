# Google Sheets with Apps Script

This integration uses an Apps Script Web App. It does not require Google Cloud service-account credentials or a Google Sheets API key.

The assistant collects the patient's name, phone number, treatment/problem, and preferred appointment date/time. It asks the patient to confirm those details, then saves the booking to a `Bookings` tab.

## 1. Add the Apps Script code

1. Open the target Google spreadsheet.
2. Select **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with the code from [`apps-script/Code.gs`](./apps-script/Code.gs).
4. Save the project.

The script creates a `Bookings` tab and its header row automatically on the first saved booking if the tab does not exist.

## 2. Add private script properties

In the Apps Script editor, open **Project Settings** (gear icon), then under **Script Properties** select **Add script property**. Add:

| Property | Value |
| --- | --- |
| `SPREADSHEET_ID` | The ID between `/spreadsheets/d/` and `/edit` in the Google Sheet URL |
| `APP_SHARED_SECRET` | A unique random secret with at least 32 characters |

Generate a secret locally in PowerShell with Node.js:

```powershell
& "C:\Program Files\nodejs\node.exe" -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the same generated secret in Script Properties and `.env.local`. Do not share or commit it.

## 3. Deploy as a Web App

1. In Apps Script, select **Deploy → New deployment**.
2. Select the gear/type menu and choose **Web app**.
3. Set **Execute as** to **Me**.
4. Set **Who has access** to **Anyone** so the Next.js server can call it. The script checks the shared secret before writing; keep that secret private.
5. Select **Deploy** and complete Google's authorization prompt.
6. Copy the Web App URL ending in `/exec`.

If your Google Workspace administrator does not allow the **Anyone** access option, ask them about an approved deployment setting; do not publish the shared secret.

## 4. Configure the Next.js app

Keep `GEMINI_API_KEY` in `.env.local`. Remove the old service-account variables if you added them:

- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

Add the deployed URL and the same random secret:

```env
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
GOOGLE_SHEETS_SHARED_SECRET=the_same_random_secret
```

Do not use a `NEXT_PUBLIC_` prefix for either variable. Restart the Next.js server after saving `.env.local`:

```powershell
npm.cmd run dev
```

## 5. Test

After deploying the Apps Script and restarting Next.js, run this PowerShell health check from the project folder. It verifies that the app can reach Apps Script and that Apps Script can open the spreadsheet; it does not add a patient row:

```powershell
$result = Invoke-RestMethod -Uri "http://localhost:3000/api/appointments" -Method Post -ContentType "application/json" -Body '{"action":"health"}'
$result
```

Success returns `ready: True`. The check creates the `Bookings` tab and header row if they do not exist, but does not create an appointment. Then start a voice session, provide the four booking details, and explicitly confirm them when the receptionist reads them back. A successful save appends one row with status `Confirmed`.

If the code in Apps Script changes later, deploy a new version using **Deploy → Manage deployments → Edit → New version → Deploy**. Keep `.env.local`, Apps Script properties, and any downloaded credentials private.
