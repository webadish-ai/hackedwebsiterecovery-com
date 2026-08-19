# Google Ads Strategy: WordPressRecovery.in

## 1. Campaign Structure
- **Campaign Type**: Search
- **Bidding Strategy**: Maximize Conversions (Target CPA if enough data)
- **Location**: India (all states, or focus on major tech hubs: Mumbai, Bangalore, Delhi, Hyderabad, Pune, Ahmedabad)
- **Language**: English
- **Landing Page Positioning**: India-only emergency WordPress recovery brand, backed by WebAdish LLP.

## 2. High-Intent Keywords (India)
Focus on "Emergency" and "Help" keywords where users are in a crisis.

### Group A: Emergency Recovery
"hacked wordpress recovery india"
"emergency wordpress help india"
"wordpress site hacked fix"
"malware removal service for wordpress india"
"expert wordpress hack recovery"
"wordpress website recovery"
"wordpress compromised"

### Group B: Google Blacklist / Warning
"fix google blacklist wordpress india"
"remove malware warning from site"
"google says my site is hacked help"
"deceptive site ahead fix wordpress"

### Group C: Specific Symptoms
"wordpress site redirecting to spam"
"wordpress admin locked hacked"
"wordpress hosting suspended malware"
"wordpress keeps getting hacked"
"wordpress hacked redirect"
"wordpress redirect malware"
"my wordpress site was hacked"
"wordpress blog hacked"


## 4. Negative Keywords (CRITICAL - Add these to prevent waste)
Add these as "Campaign Level" negatives:
- `free`, `tutorial`, `how to`, `course`, `job`, `salary`, `vacancy`, `download`, `nulled`, `plugin download`, `youtube`, `training`, `internship`.

## 5. Bidding Strategy (How to Fix Under-Spending)
**Problem:** If you are using Manual CPC and spending very little (e.g., ₹200/week), your bids are too low to enter the auction against competitors.
**Solution:** You have ₹20,000 in free credit that expires soon. You need to spend it to get data and leads.

*   **Primary Goal**: Spend the daily budget (₹600) efficiently to capture high-intent leads and utilize the promotional credit.
*   **Strategy**: Change to **Maximize Clicks**.
*   **Max CPC Bid Limit**: Set a cap of **₹120 - ₹150**.
*   **Why**: "Maximize Clicks" forces Google to find traffic, while the "Bid Limit" protects you from paying outrageous amounts (like ₹500/click) for a single click. Once you get 10-15 conversions, you can switch to "Target CPA".


### Ad 1: Crisis Response
- **Headline 1**: Hacked WordPress Site?
- **Headline 2**: We Fix It Today - ₹14,999+
- **Headline 3**: 24/7 Emergency Recovery
- **Description 1**: Redirecting to spam or Google warnings? Expert malware removal & full recovery by specialists.
- **Description 2**: Free diagnosis. Fixed quote upfront. WhatsApp now for the fastest response in India.

### Ad 2: Professional / Expert
- **Headline 1**: Expert WordPress Recovery
- **Headline 2**: Malware Removal from ₹14,999
- **Headline 3**: Free Initial Diagnosis
- **Description 1**: Don't lose your SEO rankings. We remove backdoors & secure your site for the long term.
- **Description 2**: Trusted by Indian businesses. Same-day service available. WhatsApp or Call us now.

## 4. Tracking & Conversions
- **Primary Conversion**: `thank-you` page load (Event: `generate_lead`).
- **Secondary Conversion**: Click on the WhatsApp button (Event: `whatsapp_click`).
- **Call Conversion**: Click on the phone number link (Event: `phone_click`).

### How to Fix "Domain webadish.com" issue in Google Ads:
When creating a new conversion action, Google might scan your account and suggest `webadish.com`. **Ignore the scan.**
1. In Google Ads, go to **Goals > Conversions > Summary**.
2. Click **+ New conversion action**.
3. Select **Website**.
4. Instead of letting it scan, scroll down and look for **"Add a conversion action manually using code"**.
5. Set the category to **Submit lead form**.
6. Set the conversion name to **WordPress Recovery Lead (IN)**.
7. Use the **GA4 Measurement ID (G-P4RW7GGCW8)** you already created.
8. Because the website is already sending `generate_lead` events to that GA4 ID, you can simply **Import** the conversion from GA4 into Google Ads.

### How to Import from GA4:
1. In Google Ads, click **+ New conversion action**.
2. Select **Import**.
3. Select **Google Analytics 4 properties (Web)**.
4. If your new GA4 property is linked to Google Ads, you will see the `generate_lead` event there. Select it and click **Import and continue**.

## 5. Trust Factors to Highlight in Ads
- 20+ Years Experience.
- Same-Day Service.
- UPI / Bank Transfer Accepted.
- Backup taken before cleanup.
- Fixed Quote upfront.
- Specialist WordPressRecovery.in service by WebAdish LLP.

## 6. Launch Checks
- UK pricing removed from WordPressRecovery.in.
- WebAdish LLP parent-brand logo added to nav, hero, and footer.
- `.vercelignore` excludes local `.env` secrets from deployments.
- Use the live `https://www.wordpressrecovery.in/` URL once production is promoted.
