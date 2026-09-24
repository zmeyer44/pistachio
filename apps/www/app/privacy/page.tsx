import type { Metadata } from "next";
import Link from "next/link";

import { SectionLabel } from "../../components/primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { Prose, ProseLayout } from "../../components/site-prose";

export const metadata: Metadata = {
  title: "Pistachio privacy policy",
  description:
    "How Pistachio accesses, uses, stores, and shares browsing, account, Gmail, and Google Calendar data, and how to revoke access or request deletion.",
};

/** Keep these disclosures in step with the product and date each change. */
const LAST_UPDATED = "22 September 2026";

const SECTIONS = [
  { id: "summary", title: "In short" },
  { id: "on-your-mac", title: "What stays on your Mac" },
  { id: "model", title: "What goes to your model provider" },
  { id: "google", title: "Gmail and Google Calendar" },
  { id: "google-retention", title: "Google data retention and deletion" },
  { id: "account", title: "What an account stores" },
  { id: "cloud", title: "Cloud browser and egress" },
  { id: "website", title: "This website" },
  { id: "control", title: "Your choices" },
  { id: "contact", title: "Contact and changes" },
] as const;

export default function PrivacyPage() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-col items-center bg-cream">
        <section className="shell flex flex-col gap-10 pt-[108px] pb-20 md:pt-[124px] desk:gap-14 desk:pb-28">
          <SectionLabel>Privacy policy</SectionLabel>

          <div className="flex flex-col gap-4">
            <h1 className="text-40 text-ink tab:text-48">Privacy policy</h1>
            <p className="max-w-[640px] text-16 text-ink tab:text-20">
              Pistachio is local by default. This page says what the app keeps on your Mac, what an optional account
              stores with us, and what leaves your device when the agent works.
            </p>
            <p className="max-w-[640px] text-12 text-ink">
              Last updated {LAST_UPDATED}. Changes to this policy will be dated here.
            </p>
          </div>

          <ProseLayout sections={SECTIONS}>
            <Prose id="summary" title="In short">
              <ul>
                <li>Ordinary local browsing stays on your Mac unless you enable a feature that shares it.</li>
                <li>AI features send the information they need through Pistachio&apos;s services to model providers.</li>
                <li>
                  With an account, sync and cloud runs store records that are encrypted on your devices before they
                  reach our storage service. A cloud worker can decrypt the data needed for a Space you enable,
                  and AI requests are processed as described below.
                </li>
                <li>We do not sell personal data and do not run third-party advertising trackers in the app.</li>
              </ul>
            </Prose>

            <Prose id="on-your-mac" title="What stays on your Mac">
              <p>
                Pistachio keeps the following data on your computer. Sync, cloud features, and AI features can
                transmit the records or excerpts needed for those features, as described on this page:
              </p>
              <ul>
                <li>Browsing history, cookies and site data, bookmarks, pins, favorites, Spaces, and open tabs.</li>
                <li>
                  Memory: the facts you tell the agent to remember, in <code>memory.json</code>, with their version
                  history. You can read, edit, restore, or erase every entry in Settings → Memory.
                </li>
                <li>Reminders, in <code>reminders.json</code>, and the output of reminder runs.</li>
                <li>Per-site permission decisions, appearance, shortcuts, and other settings.</li>
                <li>
                  Data imported from another browser. Import copies each database to a temporary folder, reads it,
                  and never uploads it.
                </li>
                <li>
                  The signed activity record of each agent run, so you can replay what it did.
                </li>
              </ul>
            </Prose>

            <Prose id="model" title="What goes to your model provider">
              <p>
                When you use an AI feature, the request and relevant context are sent through Pistachio&apos;s
                control service and Vercel AI Gateway to the model provider used for that feature. Cloud runs
                make these requests from the cloud worker. Context can include page text, conversation history,
                relevant memory, and results from integrations you connected. Providers used by the current
                app include OpenAI, Anthropic, and TypeSafe AI (Jev). The model used can vary by feature and
                configuration. These services process that information to produce the response you requested.
              </p>
              <p>
                Saved passwords are never included. A value the vault types for the agent goes straight into the page
                field; the model learns only that the field was filled.
              </p>
            </Prose>

            <Prose id="google" title="Gmail and Google Calendar">
              <p>
                Connecting Google is optional. In Settings → Integrations, you choose the Google account, Space,
                and access level, then authorize Pistachio on Google&apos;s consent screen. We do not receive your
                Google password. The account label and granted permissions identify the connection.
              </p>
              <ul>
                <li>
                  <strong>Gmail:</strong> read access lets you search and read messages, including their senders,
                  recipients, subjects, contents, dates, and labels. With write access, the agent can create drafts
                  and organize mail. Pistachio makes sending available only at the send access level, even though
                  Google&apos;s write permission also permits sending. The daily brief reads recent inbox
                  metadata and snippets to help you identify messages that need attention.
                </li>
                <li>
                  <strong>Google Calendar:</strong> read access lets you view calendars, events, descriptions,
                  times, locations, meeting links, attendees, responses, and availability. With write access,
                  the agent can create, update, or delete events and respond to invitations. Inviting or
                  notifying guests requires the send access level. Calendar data also supplies your home-page
                  schedule and daily brief.
                </li>
              </ul>
              <p>
                We use Google data to provide these features and carry out the tasks you request or enable.
                Relevant message or event content may be sent to the AI services described above to answer your
                request, draft a response, plan an event, or generate a brief. The schedule card itself does not
                require a model. The daily brief uses models when you open it or enable automatic generation.
                Cloud tasks process the necessary data on your assigned cloud worker. Sending email, inviting
                guests, or sharing an artifact can disclose the content you choose to the recipients you select.
              </p>
              <p>
                Pistachio&apos;s use and transfer of information received from Google APIs adheres to the{" "}
                <a href="https://developers.google.com/terms/api-services-user-data-policy">
                  Google API Services User Data Policy
                </a>
                , including its Limited Use requirements. We do not sell Google user data, use it for advertising
                or credit decisions, or use it to train general-purpose AI models. Transfers are limited to
                providing the features you authorize, security purposes, legal obligations, or a business
                transfer with your prior explicit consent. Human access is limited to your affirmative agreement
                to specific data, necessary security investigations, legal obligations, or permitted aggregated
                internal operations.
              </p>
            </Prose>

            <Prose id="google-retention" title="Google data retention and deletion">
              <p>
                The refresh token that maintains your connection is encrypted under your Space key on your Mac
                before it is stored by Pistachio. Devices holding that key, including your assigned cloud worker
                when enabled, can use it. Access tokens are kept in memory by the executor and are not stored
                as connection records or sent to the model. The provider, account label, access level, connection
                status, and usage timestamps are stored with the encrypted connection.
              </p>
              <p>
                We keep a connection until you disconnect it or request account deletion. Disconnect from
                Settings → Integrations to stop future use. A device with the Space key attempts to revoke the
                grant with Google and deletes the connection record. A disconnect requested on the web blocks
                further use immediately and leaves an encrypted record pending revocation by a key-holding
                device. You can also revoke access directly in your{" "}
                <a href="https://myaccount.google.com/connections">Google Account connections</a>.
              </p>
              <p>
                Disconnecting does not erase messages or events in Google, or copies of information already
                included in conversations, reports, memories, or artifacts. Those records remain until removed
                through the applicable product controls or an account-deletion request. To request deletion
                of your account and associated Google data, email{" "}
                <a href="mailto:zmmeyer44@gmail.com">zmmeyer44@gmail.com</a>. Operational logs and backups may
                persist until their retention periods expire; records required for security or legal obligations
                may be retained for those purposes. Model providers&apos; processing and retention terms also
                apply to data already sent to them; disconnecting Google does not recall those requests.
              </p>
            </Prose>

            <Prose id="account" title="What an account stores">
              <p>
                A signed-in account lets your devices share sessions and Spaces and lets the agent run when
                your Mac is asleep. AI features can also use an anonymous device account for authentication
                and usage limits before you sign in. Account records include:
              </p>
              <ul>
                <li>Your email address and a password hash, and the phone number you connect for iMessage if you choose to.</li>
                <li>
                  Enrolled devices: a public key, platform, name, and enrollment time for each Mac or browser you sign in
                  from, and the signed tokens they use.
                </li>
                <li>
                  Synced records for sessions (cookies), Spaces, and tab restore points. Each is encrypted on your
                  device under keys only your devices hold before it is uploaded. Our servers see record ids, sizes,
                  and timestamps.
                </li>
                <li>
                  Vault entries you choose to keep: the site and field names in the clear, the values as ciphertext
                  sealed by your device.
                </li>
                <li>Connected Gmail and Google Calendar accounts, as described above.</li>
                <li>AI usage records such as model, token counts, request size, cost, status, and timestamps.</li>
                <li>
                  Artifacts the agent builds for you, encrypted and private to your account unless you deliberately
                  publish one to a share link.
                </li>
                <li>Billing information for a paid plan, handled by our payment processor.</li>
              </ul>
              <p>
                Losing your password and recovery code means losing access to the encrypted records; we cannot decrypt
                them for you.
              </p>
            </Prose>

            <Prose id="cloud" title="Cloud browser and egress">
              <p>
                For a Space you explicitly turn the cloud browser on for, a hosted browser can run agent tasks using
                that Space&apos;s synced sessions. While a run is active, that browser holds the Space&apos;s sessions in
                memory and its requests go through a private egress gateway with a static address dedicated to you,
                so sites see the same address from your Mac and from the cloud. Runs, their conversations, and their
                activity records are stored for your account so you can review them from any device.
              </p>
              <p>Spaces you have not enabled never run in the cloud.</p>
            </Prose>

            <Prose id="website" title="This website">
              <p>
                pistachio.run serves static pages. If you join the early-access list we keep the name and email
                address you enter so we can send you a download link. The signed-in web app talks to our control service directly
                from your browser; the pages themselves do not receive your password or keys.
              </p>
            </Prose>

            <Prose id="control" title="Your choices">
              <ul>
                <li>Use local browsing without enabling sync, integrations, cloud tasks, or AI features.</li>
                <li>Edit or erase memory and reminders, and clear a Space&apos;s site data, at any time from Settings.</li>
                <li>Revoke any enrolled device, disconnect any integration, or remove any vault entry from Settings.</li>
                <li>Turn the cloud browser off per Space.</li>
                <li>Ask us to remove your account and the records above; see the contact section below.</li>
              </ul>
            </Prose>

            <Prose id="contact" title="Contact and changes">
              <p>
                For privacy questions or deletion requests, email{" "}
                <a href="mailto:zmmeyer44@gmail.com">zmmeyer44@gmail.com</a>. Please do not post private
                messages, event details, or credentials in a public issue. When this policy changes, the date
                at the top changes with it. Material changes to Google data use require notice and renewed
                consent before that use begins. See also the{" "}
                <Link href="/docs#privacy">privacy and permissions docs</Link>.
              </p>
            </Prose>
          </ProseLayout>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
