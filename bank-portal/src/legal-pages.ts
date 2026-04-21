/**
 * Long-form legal copy for the bank portal. Update `LEGAL_EFFECTIVE_DATE_DISPLAY`
 * when you publish substantive changes, and have qualified counsel review before launch.
 */
export const LEGAL_EFFECTIVE_DATE_DISPLAY = "April 21, 2026";

/** Shared HTML body (inside `.fx-doc__prose`) for the Privacy Policy. */
export function privacyPolicyProseHtml(): string {
  return `
    <p><strong>Effective date:</strong> ${LEGAL_EFFECTIVE_DATE_DISPLAY}</p>
    <p>
      This Privacy Policy describes how we, operating the Services under the name <strong>A.Pay</strong> (“<strong>we</strong>,” “<strong>us</strong>,” or “<strong>our</strong>”),
      collects, uses, discloses, stores, and otherwise processes information when you access or use our websites, mobile experiences,
      authentication flows, application programming interfaces, and related products and services (collectively, the “<strong>Services</strong>”).
      By using the Services, you acknowledge that you have read this notice and understand the practices described here, subject to applicable law.
    </p>

    <h2>1. Scope and relationship</h2>
    <p>
      This policy applies to personal information we process in connection with the Services. It does not apply to third-party websites,
      applications, or services that we do not control (including your financial institution’s own portals or policies), even if you reach them through links we provide.
      Those third parties process information under their own terms and privacy notices.
    </p>

    <h2>2. Information we collect</h2>
    <p>Depending on how you use the Services, we may collect or receive the following categories of information:</p>
    <h3>2.1 Account and profile data</h3>
    <p>
      When you register or maintain an account, we process identifiers such as your email address, authentication tokens or session identifiers,
      display name, preferences (for example theme or accent settings), and similar profile fields you choose to provide.
    </p>
    <h3>2.2 Financial connection and planning data</h3>
    <p>
      If you connect a financial institution, we (and our service providers) may process institution names, account identifiers, account types,
      masked or full account numbers as returned by the provider, balances, transaction descriptions, amounts, dates, merchant or counterparty labels,
      categorization or tags you apply, and derived planner inputs and outputs (for example snapshots, allocations, forecasts, reminders, and “safe to spend” style calculations).
    </p>
    <h3>2.3 Technical, security, and operational data</h3>
    <p>
      We collect standard device and connection data such as IP address, approximate location derived from IP, browser or app version, operating system,
      diagnostic logs, timestamps, error reports, and security signals (for example failed sign-in attempts) to operate, secure, and improve the Services.
    </p>
    <h3>2.4 Communications and support</h3>
    <p>
      If you contact us, we process the contents of your message, attachments you send, and related metadata (such as topic, email address, and correspondence history)
      to respond and maintain records of our relationship with you.
    </p>
    <h3>2.5 Cookies, local storage, and similar technologies</h3>
    <p>
      We and our infrastructure providers may use cookies, local storage, session storage, and similar technologies that are strictly necessary for authentication,
      session continuity, load balancing, fraud prevention, and basic analytics tied to service reliability. If we introduce optional analytics or marketing cookies,
      we will describe them and, where required, obtain consent before they run.
    </p>

    <h2>3. Sources of information</h2>
    <p>We obtain personal information from:</p>
    <ul>
      <li><strong>You</strong>, when you create an account, connect accounts, enter planner data, upload content, or communicate with us;</li>
      <li><strong>Authentication and database providers</strong> (for example Supabase) that facilitate sign-in and storage of profile or application state;</li>
      <li><strong>Financial data partners</strong> (for example Teller) when you complete bank linking flows they operate or when they send webhooks or API payloads to our backend;</li>
      <li><strong>Automated systems</strong> that derive planner outputs from the underlying data you or your connections supply.</li>
    </ul>

    <h2>4. How and why we use information</h2>
    <p>We use personal information for purposes that include:</p>
    <ul>
      <li><strong>Providing the Services</strong> — creating and securing your account, syncing planner state, displaying accounts and transactions, computing forecasts, and delivering in-product messaging;</li>
      <li><strong>Integrity and security</strong> — detecting, investigating, and preventing fraud, abuse, unauthorized access, and violations of our terms;</li>
      <li><strong>Reliability and improvement</strong> — debugging, quality assurance, performance measurement, and developing features, including through aggregated or de-identified analytics where permitted;</li>
      <li><strong>Communications</strong> — sending transactional notices (such as security alerts, policy updates, or receipts for requests you initiate);</li>
      <li><strong>Legal and compliance</strong> — complying with law, responding to lawful requests from public authorities, and enforcing our agreements;</li>
      <li><strong>Business operations</strong> — bookkeeping, internal audits, corporate transactions (such as a merger), and continuity planning, subject to applicable law.</li>
    </ul>
    <p>
      Where the GDPR, UK GDPR, or similar frameworks apply, we rely on one or more lawful bases such as <strong>performance of a contract</strong> with you,
      <strong>legitimate interests</strong> that are not overridden by your rights (for example securing accounts and improving reliability),
      <strong>consent</strong> where required (for example certain non-essential cookies or marketing), and <strong>legal obligation</strong>.
    </p>

    <h2>5. Automated processing and “advice” boundaries</h2>
    <p>
      Certain features apply rules, heuristics, or deterministic engines to your data to produce forecasts, reminders, or spending guidance.
      These outputs are computational tools intended to help you organize your finances; they are <strong>not</strong> individualized investment, tax, legal, or other professional advice,
      and they may be incomplete or inaccurate if underlying data is stale or incorrect. You remain responsible for your financial decisions.
    </p>

    <h2>6. How we disclose information</h2>
    <p>We disclose personal information only as described in this policy or at the time of collection. Categories of recipients include:</p>
    <ul>
      <li><strong>Infrastructure and subprocessors</strong> — cloud hosting, authentication, database, serverless compute, logging, and email delivery vendors that process data on our behalf under contractual safeguards;</li>
      <li><strong>Financial connectivity partners</strong> — for example Teller, to initiate connections, refresh data, and receive webhooks;</li>
      <li><strong>Professional advisors</strong> — lawyers, accountants, or insurers under confidentiality obligations;</li>
      <li><strong>Authorities and parties to legal process</strong> — when we believe disclosure is required by law, regulation, legal process, or governmental request, or to protect rights, safety, and security;</li>
      <li><strong>Business transfers</strong> — a successor or acquirer in a merger, acquisition, financing, reorganization, bankruptcy, or sale of assets, subject to appropriate protections.</li>
    </ul>
    <p>We do <strong>not</strong> sell your personal information for money as that term is commonly understood in U.S. state privacy laws, and we do not share it for cross-context behavioral advertising.</p>

    <h2>7. International transfers</h2>
    <p>
      We may process and store information in the United States and other countries where we or our vendors operate. Those countries may have data protection laws
      that differ from the country where you live. Where required, we implement appropriate safeguards (such as standard contractual clauses approved by regulators)
      for transfers of personal data from the EEA, UK, or Switzerland.
    </p>

    <h2>8. Retention</h2>
    <p>
      We retain personal information for as long as reasonably necessary to provide the Services, comply with legal obligations, resolve disputes, enforce agreements,
      and maintain security backups in accordance with our retention schedules. Retention periods vary based on data category, legal requirements, and whether you maintain an active account.
      When retention periods expire, we delete or de-identify information where feasible, unless a narrow exception (such as litigation holds) applies.
    </p>

    <h2>9. Security</h2>
    <p>
      We implement administrative, technical, and organizational measures designed to protect personal information against accidental or unlawful destruction, loss, alteration,
      unauthorized disclosure, or access. No method of transmission or storage is completely secure; you should protect your credentials, enable multi-factor authentication when available,
      and notify us promptly if you suspect unauthorized access.
    </p>

    <h2>10. Your choices and rights</h2>
    <p>Depending on your location, you may have rights to:</p>
    <ul>
      <li>access or receive a copy of certain personal information;</li>
      <li>correct inaccurate or incomplete information;</li>
      <li>delete certain information, subject to exceptions;</li>
      <li>restrict or object to certain processing;</li>
      <li>port information to another service, where technically feasible;</li>
      <li>withdraw consent where processing is consent-based, without affecting the lawfulness of prior processing;</li>
      <li>lodge a complaint with a supervisory authority.</li>
    </ul>
    <p>
      You can exercise many controls inside the product (for example disconnecting linked institutions or deleting profile fields). For other requests, contact us through the
      <strong>Contact</strong> page and include enough detail for us to verify your identity. We may need additional information to process your request and will respond within the timeframes required by law.
    </p>

    <h2>11. U.S. state privacy notices (including California)</h2>
    <p>
      If you are a resident of a U.S. state with a comprehensive privacy law, you may have additional rights regarding access, deletion, correction, portability, and opt-out of certain processing.
      We honor applicable rights and do not discriminate against you for exercising them. Authorized agents may submit requests on your behalf where permitted, with proof of authorization.
    </p>
    <p>
      California residents: over the preceding twelve months we may have collected the categories described in Section 2 for the business purposes in Sections 4–6.
      We do not “sell” or “share” personal information as those terms are defined in the California Consumer Privacy Act (CCPA), as amended. Sensitive personal information,
      if collected, is used only for permitted purposes and not to infer characteristics about you beyond what is necessary to provide the Services.
    </p>

    <h2>12. Children</h2>
    <p>
      The Services are not directed to children under 16 (or the higher age required in your jurisdiction), and we do not knowingly collect personal information from children.
      If you believe we have collected information from a child, please contact us and we will take appropriate steps to delete it.
    </p>

    <h2>13. Changes to this policy</h2>
    <p>
      We may update this Privacy Policy from time to time. When we make material changes, we will post the revised policy on this page and update the effective date above,
      and where required we will provide additional notice (such as an in-product message or email). Your continued use of the Services after the effective date of changes constitutes your acknowledgment
      of the updated policy, to the extent permitted by law.
    </p>

    <h2>14. How to contact us</h2>
    <p>
      For privacy questions or requests, use the <strong>Contact</strong> section of this website and choose the privacy or security topic, or follow any dedicated privacy inbox we publish here.
      We will work with you and, where applicable, your regulator to resolve concerns.
    </p>
  `;
}

/** Shared HTML body (inside `.fx-doc__prose`) for the Terms of Service. */
export function termsOfServiceProseHtml(): string {
  return `
    <p><strong>Effective date:</strong> ${LEGAL_EFFECTIVE_DATE_DISPLAY}</p>
    <p>
      These Terms of Service (“<strong>Terms</strong>”) govern your access to and use of the websites, applications, and related services operated under the A.Pay name
      (collectively, the “<strong>Services</strong>”). By creating an account, clicking to accept, or otherwise using the Services, you agree to these Terms on behalf of yourself
      or the entity you represent. If you do not agree, do not use the Services.
    </p>

    <h2>1. Who may use the Services</h2>
    <p>
      You must be the age of digital consent in your jurisdiction (and at least 18 where required) and able to form a binding contract. If you use the Services on behalf of an organization,
      you represent that you have authority to bind that organization, and “you” includes that organization.
    </p>

    <h2>2. The Services are planning tools, not a bank or advisor</h2>
    <p>
      A.Pay provides software-based cashflow planning, forecasting, categorization, and related informational outputs. The Services are <strong>not</strong> a bank, broker-dealer, creditor,
      money transmitter, or fiduciary, and they do not move funds, execute payments on your behalf, or guarantee that you will avoid fees, overdrafts, late payments, or other financial harm.
      Nothing in the Services constitutes tax, investment, accounting, or legal advice. You are solely responsible for your financial decisions and for verifying balances, due dates, and obligations with your institutions.
    </p>

    <h2>3. Accounts, credentials, and security</h2>
    <p>
      You must provide accurate registration information and keep it current. You are responsible for safeguarding passwords, API keys, devices, and any other credentials used to access your account,
      and for all activity that occurs under your account until you notify us of unauthorized use. Enable multi-factor authentication when we make it available. You will not attempt to access another user’s account
      or our systems without authorization, and you will not interfere with the integrity or performance of the Services.
    </p>

    <h2>4. Financial institution connections</h2>
    <p>
      Certain features rely on third-party connectivity providers (for example Teller) to link financial institutions and retrieve account and transaction data. Your use of those flows is also subject to the provider’s
      end-user terms, privacy policy, and consent screens. We are not responsible for the availability, accuracy, timeliness, or practices of your financial institution or the connectivity provider.
      You authorize us and our providers to access, store, process, and display information retrieved through connections you initiate, as described in our Privacy Policy.
    </p>

    <h2>5. License to you; restrictions</h2>
    <p>
      Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, revocable license to access and use the Services for your personal or internal business purposes.
      You will not (and will not assist others to): reverse engineer, decompile, or disassemble any part of the Services except to the limited extent expressly permitted by applicable law;
      scrape, data-mine, or harvest the Services in an undue or abusive manner; circumvent technical limits or security controls; use the Services to build a competing product using our proprietary interfaces;
      upload malware; or use the Services in violation of law or third-party rights.
    </p>

    <h2>6. User content and feedback</h2>
    <p>
      You retain ownership of data you submit. You grant us a worldwide, royalty-free license to host, copy, process, transmit, and display your content solely to provide, secure, and improve the Services
      and as described in our Privacy Policy. If you provide feedback or suggestions, you grant us an unrestricted, perpetual license to use them without obligation to you.
    </p>

    <h2>7. Third-party services and links</h2>
    <p>
      The Services may reference or link to third-party sites, merchants, or tools. We do not control and are not responsible for third-party content, terms, or privacy practices.
      Your interactions with third parties are solely between you and them.
    </p>

    <h2>8. Changes to the Services and Terms</h2>
    <p>
      We may modify, suspend, or discontinue any part of the Services (including features dependent on external APIs) with or without notice. We may update these Terms from time to time.
      If a change is material, we will provide reasonable advance notice when required by law (for example by posting an updated policy, showing an in-product alert, or emailing the address on your account).
      Your continued use after the effective date of updated Terms constitutes acceptance. If you do not agree, you must stop using the Services.
    </p>

    <h2>9. Fees</h2>
    <p>
      Some features may be free while others require payment. If we charge fees, we will present the price and billing terms before you incur charges. Taxes may apply. Unless stated otherwise,
      fees are non-refundable except where required by law. We may change pricing prospectively with notice.
    </p>

    <h2>10. Disclaimers</h2>
    <p>
      THE SERVICES AND ALL INFORMATION PROVIDED THROUGH THEM ARE PROVIDED “AS IS” AND “AS AVAILABLE,” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY,
      INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT OUTPUTS WILL BE ACCURATE, COMPLETE, CURRENT, OR ERROR-FREE,
      OR THAT THE SERVICES WILL BE UNINTERRUPTED OR FREE OF HARMFUL COMPONENTS.
    </p>

    <h2>11. Limitation of liability</h2>
    <p>
      TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL A.PAY OR ITS SUPPLIERS, AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
      CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SERVICES, EVEN IF WE HAVE BEEN ADVISED
      OF THE POSSIBILITY OF SUCH DAMAGES. OUR AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICES IN ANY TWELVE-MONTH PERIOD IS LIMITED TO THE GREATER OF (A) ONE HUNDRED U.S. DOLLARS (US $100) OR
      (B) THE AMOUNTS YOU PAID US FOR THE SERVICES DURING THAT PERIOD (IF ANY). SOME JURISDICTIONS DO NOT ALLOW CERTAIN LIMITATIONS; IN THOSE CASES, OUR LIABILITY IS LIMITED TO THE FULLEST EXTENT PERMITTED BY LAW.
    </p>

    <h2>12. Indemnity</h2>
    <p>
      You will defend, indemnify, and hold harmless A.Pay and its affiliates, personnel, and agents from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys’ fees)
      arising out of or related to your use of the Services, your content, your violation of these Terms, or your violation of law or third-party rights. We may assume exclusive defense and control of any matter subject to indemnification,
      at your expense, and you will cooperate with our reasonable requests.
    </p>

    <h2>13. Suspension and termination</h2>
    <p>
      You may stop using the Services at any time. We may suspend or terminate your access if we reasonably believe you have violated these Terms, pose a security risk, or must do so to comply with law.
      Provisions that by their nature should survive (including licenses to feedback where applicable, disclaimers, limitations of liability, indemnity, governing law, and dispute resolution) will survive termination.
    </p>

    <h2>14. Export and sanctions</h2>
    <p>
      You may not use or export the Services except as authorized by United States law and the laws of your jurisdiction. You represent that you are not located in, under the control of, or a national or resident of
      any country or entity subject to comprehensive U.S. sanctions or embargoes, and that you are not on any restricted party list.
    </p>

    <h2>15. Governing law; disputes</h2>
    <p>
      These Terms are governed by the laws of the United States and the State of Delaware, excluding conflict-of-law rules that would require applying another jurisdiction’s laws,
      except that certain consumer protection laws in your place of residence may apply regardless of this choice. Subject to mandatory consumer protections, you agree that exclusive jurisdiction and venue for disputes
      arising out of or relating to these Terms or the Services will lie in the state or federal courts located in Wilmington, Delaware, and you consent to personal jurisdiction there.
      Nothing in this section limits either party’s ability to seek injunctive relief in any court of competent jurisdiction for misuse of intellectual property or security incidents.
    </p>

    <h2>16. General</h2>
    <p>
      These Terms, together with our Privacy Policy and any additional terms presented for specific features, constitute the entire agreement between you and A.Pay regarding the Services and supersede prior oral or written understandings.
      If any provision is held unenforceable, the remaining provisions remain in effect. Our failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a merger,
      acquisition, or sale of assets. Notices to you may be provided through the Services or to the email associated with your account.
    </p>
  `;
}
