# Studgether: put it online for free (no Firebase, no accounts, no database)

Studgether is a shared study timer. One person hosts a room, friends join with a 6-letter code, and everyone sees the same countdown. A person's break status never pauses the clock.

**How it works with zero cost:** there is no server or database. Friends' browsers connect **directly to each other** (peer-to-peer, the same technology as video calls) and find each other through free public signalling services. All you need is a place to host the files. GitHub Pages is free.

---

## Put it online with GitHub Pages (about 5 minutes)

1. Sign in at https://github.com. Click **+** (top right) then **New repository**.
2. Name it `studgether`. Choose **Public**. Click **Create repository**.
3. Click **uploading an existing file**. Open this folder on your computer and drag in **everything inside it** (`index.html`, `app.js`, `styles.css`, `config.js`, `manifest.json`, and the folders `assets` and `vendor`). Do not upload the zip itself.
4. Click **Commit changes**.
5. Go to **Settings, then Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick branch `main` and folder `/ (root)`, then **Save**.
6. Wait 1 to 2 minutes. Your website is live at `https://YOUR-GITHUB-USERNAME.github.io/studgether/`

That link works for anyone, anywhere, with no sign-up. (Netlify Drop at https://app.netlify.com/drop and Cloudflare Pages are free alternatives.)

Your other GitHub Pages site is not affected.

## Try it

1. Open your link on your laptop, enter a name, and choose **Create room**.
2. Open the same link on your phone, choose **Join a room**, and enter the code (or tap the invite link from **Copy invite**).
3. Start the timer. Set the phone to *On a break*. The clock keeps running. Reload the phone, and it returns to the room.

## What it does

- Everyone sees the same clock. Each device checks real time from the website itself, so a wrong phone clock does not matter.
- If the host leaves or closes the page, the person who has been in the room longest becomes host automatically (about 5 seconds). A host who taps *Leave room* hands over instantly.
- Reloading the page puts you back in the same room.
- Nothing is stored anywhere. A room exists only while someone is in it.

## Honest limitations

- **Some phone networks block direct connections.** Most home Wi-Fi and broadband works. A few mobile data connections (strict carrier networks) cannot connect directly. The fix is a free relay (TURN). If friends report "could not find room" only on mobile data, add one in `config.js` (the file explains how).
- **Free public services are used to introduce browsers to each other** (public BitTorrent trackers and Nostr relays; both are tried at once). They are free but not guaranteed. If a room cannot be found, wait a few seconds and press Join again.
- **Everyone with the room code is trusted.** There are no passwords or accounts. Share the code only with your group.
- **Best for small groups** (about 2 to 8 people). Everyone connects to everyone.
- **Peer-to-peer apps reveal network addresses** to the people in the room (normal for this technology).
- The app needs an internet connection. If the clock reads 00:00:00 for a moment after joining, it is still syncing.

## Troubleshooting

| You see | Do this |
|---|---|
| "Could not find room" | Check the code. The host must still have the room open. Try again in a few seconds. |
| Works on Wi-Fi but not on mobile data | See the first limitation above (TURN relay). |
| Old version after uploading new files | Hard refresh (Ctrl+Shift+R). GitHub Pages can take a minute. |
| Blank page | Make sure the `vendor` folder was uploaded too. |

## For developers

`vendor/net.js` is a bundle of the open-source Trystero library (MIT licence). `vendor/net-src.js` is the small source file it was built from.
