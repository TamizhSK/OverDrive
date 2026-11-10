# BMW Overdrive UI Foundation

Overdrive is the customer-facing name of the ServiceCare solution; package, API and infrastructure names are unchanged.

The bundled wireframe informed the original support states, not the current visual layout. The application now uses a customer-care portal: login, application home, a full-page customer-care conversation, service history and a dedicated profile. Advisors have a separate operational workspace.

## Branding

- The user-supplied fonts are served locally as BMW Type Next Regular 400 and Bold 700. OpenType table metadata, rather than filenames, determines their CSS weights. Font files are unmodified; no third-party font service is called.
- `frontend/src/bmw-theme.css` owns the supplied BMW font faces and color tokens. `portal.css` owns the responsive login, customer portal, advisor desk, menus, profile and floating chat. The base stylesheet retains shared ticket layouts.
- Primary action: BMW blue `#1c69d4`; hover: `#0653b6`; text: `#262626`; surfaces: white; supporting text, borders and backgrounds: neutral grays.
- Safety and error states use red; pending states may use amber. They are functional semantics, not an alternative brand palette.
- Typography uses supplied real faces without synthetic bold/italic. No replacement font is labelled as BMW Type Next. A generic sans-serif fallback is used if font delivery fails.
- The BMW roundel is the supplied, unmodified `frontend/public/brand/bmw-logo.png`, shown next to the "Overdrive" name in the header and on Login; it replaces the former "BMW" text. It sits on a white circular backing so it stays legible on the dark advisor header. Do not redraw or recolor it.
- All application-owned photographs use visually verified BMW vehicles: a gray M4 coupe on Home and a black BMW coupe on Login/Profile. User-selected evidence is separate from application branding. Confirm font, logo and photography licensing before external distribution.

## Application Flow

| Requirement | React implementation |
| --- | --- |
| First visit | Login with full-height BMW photograph beside the form on tablet/desktop. On phones it is one screen-high column: the photograph takes the height left over above a rounded form sheet, so the page does not scroll on phones from 320x568 up. If the screen is too short (landscape, on-screen keyboard) the page scrolls instead of clipping. Pull-to-refresh and bounce are disabled on this page. The form leads with the BMW roundel, an English "Welcome to Overdrive" kicker and the German headline "Freude am Fahren.", and ends with a Forgot password link instead of a footer |
| Forgot password | With a configured HTTPS Cognito domain the link opens the hosted `/forgotPassword` page for the app client and returns to `/auth/callback`; it is withheld for non-HTTPS domains and non-loopback HTTP origins. In demo or unconfigured mode it toggles an explanatory notice |
| Real login | Redirect to Cognito authorization-code + PKCE with email as login hint; no local password collection |
| Local demo | Explicit Enter demo; session marker required; role selection only on Login; sign-out clears session |
| Customer home | Edge-to-edge BMW hero (not confined to the content column) with lower-corner copy on a soft, faded gradient rather than a boxed shadow, service counts and six distinct category links; no repeated account/request redirect cards |
| Ask Overdrive | One full-page chat with a scrollable transcript, fixed composer and expandable Common Issues section; no separate chat window. Choosing a common issue and typing a concern take the same path: every non-safety concern searches approved guidance first. The chat height is derived from the header and bottom-bar heights so the page itself never scrolls |
| Profile | Authenticated account details or labelled demo account; sample vehicle/recorded readings only in demo mode |
| Source or evidence | Expandable source references from the assistant response |
| Helpful / Not helpful | Separate local answer-rating selection; it does not silently mark an issue resolved or create a request |
| Issue resolved | Explicit Yes, resolved submits feedback; Close conversation returns Home; critical or ungrounded answers cannot self-resolve. Resolved questions are listed under Resolved self-service on My Requests |
| Request service follow-up | The Create a service request action opens the Create a service request page with the concern already entered as title and description. The customer reviews, edits, optionally adds evidence and submits; there is no dialog |
| Real confirmation | Submit ticket saves a ticket through the existing API, then shows its actual generated ticket reference; no fixed mock reference |
| Safety stop | Immediate safety guidance, no self-resolution, confirmed advisor follow-up |
| Floating chat icon | Chat-symbol link to the full-page conversation, shown off the chat page only; no duplicate Help Centre navigation item |
| Image evidence | Up to five JPEG/PNG/WebP previews, 10 MB per image; carried to the request page and uploaded through the existing S3 adapter only when the request is submitted in AWS mode |
| Advisor workspace | Dark operational header, workload counts, filtered queue and existing ticket-management controls; no customer chatbot |
| Responsive navigation | Home / My Requests only; full-height slide-in menu owns Profile and sign-out; notifications are beside the menu button |
| Notifications | Derived from loaded ticket statuses and public messages; private notes excluded; read markers last for the current mounted session |
| Footer | Home-only BMW Overdrive tagline; no repeated footer navigation |

Unauthenticated routes show Login. Authenticated customers enter Home; advisors enter the service queue. Existing authenticated sessions remain signed in on refresh. Direct ticket creation is available inside My Requests, not the chat header. Home category links carry `?topic=...` and open the matching issue options. The hero action scrolls to the categories rather than duplicating the chat icon's redirect. Bottom navigation and the chat composer reserve safe-area space.

## Data Boundaries

There is no header demo selector or wireframe scenario selector in the portal. The supplied eight-state fixture model remains as reference/test data. The Profile page's sample vehicle selector demonstrates display-only fixture data; it is not an authorized vehicle session. Local demo entry is not a security boundary: the local API deliberately supports fixed demo identities. The production Lambda still accepts only API Gateway-validated Cognito claims.

Production Profile does not display fixture readings or a vehicle selector. It explicitly shows that vehicle context is not connected. Do not import the full vehicle CSV into the browser: the backend must map verified Cognito identities to `owner_id`, authorize the VIN, filter active faults, and enforce joined deterministic safety flags before returning vehicle data. Choosing a role on the production login screen is only UI intent; actual access comes from authenticated Cognito groups.

The supplied KB documents are synthetic and not official BMW guidance. Answers use the assistant API and its source indicator. The visible transcript retains previous questions/answers while the page is mounted, but the backend still answers each submitted concern independently; this is not server-side multi-turn memory. Helpfulness ratings remain local UI feedback, not stored analytics. Resolved feedback uses the existing API and is listed back to the customer through `GET /api/assistant/history`. A request is created only when the customer submits the Create a service request page, which carries the original concern; contact uses the account's details because the page has no contact-preference field. Sending email, making calls, confirming appointments and dispatching assistance are not implemented.

Chat images are evidence for an advisor, not vision-model input. There is no automatic photo analysis. Images are validated by MIME metadata, count and size, previewed via object URLs and revoked on removal/unmount. In AWS mode they upload when the request is submitted and their references are stored on the ticket. In demo mode they are local previews only and are not carried to the request page. A failed upload must not create a ticket claiming an attachment exists. Malware scanning and abandoned-upload cleanup are separate production requirements.

Notifications show updates from loaded requests, not push notifications or a persistent notification store. Refresh My Requests for current activity. Read/unread state does not persist after sign-out/refresh. Internal advisor notes never generate customer notifications.

## Verification

Run `npm.cmd test` for category/workload/session invariants, notification privacy, image type/size/count limits, rendered route checks, reference fixtures and API behavior. The render test verifies two-item navigation, category deep links, attachment controls, no duplicate chat window, no Profile shortcut outside the menu, request creation from My Requests, and separate advisor UI. Run `npm.cmd run build -w @servicecare/web` for the frontend production build.

Browser checks for this revision covered Login image dimensions at 390/768/1440 CSS pixels; full-height menu slide-in and animated dismissal; real notification entries; Home category -> matching chat options; resolved -> Close conversation -> Home; icon -> full-page chat; image preview/removal; blocked fake demo uploads; and confirmed request creation. Chat layout was checked at 390/768/1024/1440 pixels for overflow, duplicate windows and bottom-bar overlap. The latest pass also confirmed that the Home hero starts at the left viewport edge, the composer controls share one height, the greeting/Common issues/answer/composer share one column, and the resolution buttons remain visible after a photo is attached. Photos were inspected directly to verify BMW branding. The request-page revision was walked through in the demo browser at desktop width and 390 pixels: typed concern -> knowledge-first answer -> Create a service request -> pre-filled page -> submit, and resolved -> My Requests listing under Resolved self-service. Actual S3 upload/download and mobile virtual-keyboard behavior still require their own device/AWS checks.