# Gmail setup

Senderban talks to Gmail through a Google Cloud project that you own. Nobody else holds access to
your mail, and there is no Senderban server in between. This is a one-time setup. It needs a Google
account and no payment.

Google changes the console's wording from time to time. If a label below does not match, look for the
nearest one.

## 1. Make the project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and create a new project.
2. Under **APIs & Services**, **Library**, find **Gmail API** and turn it on.

## 2. Set up the sign-in page

Open **Google Auth Platform** in the same project.

1. **Branding:** give the app a name and your e-mail address.
2. **Audience:** choose **External**, then add your own Gmail address under **Test users**.
3. **Data Access:** add exactly these two scopes:
   - `https://www.googleapis.com/auth/gmail.metadata`: the sender and subject for the notification.
   - `https://www.googleapis.com/auth/gmail.settings.basic`: the filters that block a sender.

## 3. Make the client

1. **Clients**, **Create client**, type **Desktop app**.
2. Copy the **Client ID** and the **Client secret**. The console may not show the secret again.

## 4. Connect Senderban

1. Open Senderban from the tray icon, then **Accounts**, **Add mailbox**, **Gmail**.
2. Paste the client ID and secret, and press **Save client**. The secret is stored encrypted on this
   device.
3. Press **Add Gmail account** and sign in in your browser.
4. Google shows "Google hasn't verified this app". That is expected: the app is your own project.
   Continue.
5. Press **Restart now**.

A mail that arrives after that shows a notification with **Move this sender to Trash**.

## Sign-in expires after 7 days in Testing

A project in **Testing** gets a 7-day sign-in: Senderban shows the end date and, after it, "Access
expired". Sign in again, or use **Publish app** under **Audience** to move your project to **In
production**, where Google no longer returned an expiry. Google may ask for a home page and a privacy
policy link before it lets you publish.

## Undo

Removing the account under **Accounts** revokes Senderban's access at Google. You can also
revoke it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
