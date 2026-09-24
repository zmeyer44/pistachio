/**
 * Pages and labelled descriptions for the live accuracy check. The
 * descriptions deliberately avoid the words of the passage they point at:
 * anything an exact find could do is not what this feature is for.
 * `answer` is the index of the passage a person would want; `also` lists
 * passages that are acceptable first hits too. `null` means the page holds
 * no answer and nothing confident should come back.
 */
export interface FixturePage {
  name: string;
  passages: string[];
  queries: { search: string; answer: number | null; also?: number[] }[];
}

export const FIXTURES: FixturePage[] = [
  {
    name: "terms of service",
    passages: [
      "These Terms govern your use of the Orchard storage service. By creating an account you agree to them in full.",
      "You must be at least sixteen years old to open an account. Accounts opened on behalf of a company bind that company.",
      "Subscriptions renew automatically at the end of each billing period unless cancelled at least twenty-four hours beforehand.",
      "If you cancel within fourteen days of your first payment we will return the full amount to your original payment method. After that period, payments are non-refundable except where the law requires otherwise.",
      "We may suspend an account that stores unlawful material, distributes malware, or is used to harass others. We will notify you by email unless prohibited from doing so.",
      "You retain ownership of everything you upload. You grant us only the licence needed to store, back up and transmit your files at your direction.",
      "We keep deleted files for thirty days so that accidental deletions can be undone. After thirty days they are permanently erased from our systems and backups.",
      "Our total liability for any claim is limited to the fees you paid in the twelve months before the event giving rise to it.",
      "The service is provided as is. We do not promise that it will be uninterrupted or free of errors, and scheduled maintenance may make it unavailable for short periods.",
      "We may change these Terms. When a change is material we will give thirty days' notice by email, and continuing to use the service after that date means you accept the new Terms.",
      "Disputes are resolved by binding arbitration in Dublin, Ireland, conducted in English. Either party may still seek urgent relief from a court.",
      "If you stop paying, your account becomes read-only for sixty days. You can download your files during that time but cannot add new ones.",
      "Law enforcement requests are reviewed by our legal team. We disclose customer data only in response to a valid court order and we tell the affected customer when we are allowed to.",
      "You can export all of your data at any time from the Settings page as a single archive.",
    ],
    queries: [
      { search: "how do I get my money back", answer: 3 },
      { search: "can they kick me off the platform", answer: 4 },
      { search: "what happens if my card stops working", answer: 11 },
      { search: "will they hand my files to the police", answer: 12 },
      { search: "can I recover something I removed by mistake", answer: 6 },
      { search: "where would a lawsuit take place", answer: 10 },
      { search: "minimum age", answer: 1 },
      { search: "who owns the stuff I put on there", answer: 5 },
      { search: "how much could I sue them for", answer: 7 },
      { search: "do they sell my data to advertisers", answer: null },
      { search: "student discount", answer: null },
    ],
  },
  {
    name: "developer docs",
    passages: [
      "Tessera is a small HTTP client for TypeScript with first-class support for retries, timeouts and typed responses.",
      "Install it with your package manager of choice. Tessera has no runtime dependencies and ships both ESM and CommonJS builds.",
      "Create a client once and reuse it. A client holds a connection pool, so constructing one per request wastes sockets and defeats keep-alive.",
      "Every request accepts a timeout in milliseconds. When it elapses the request is aborted and the returned promise rejects with a TimeoutError.",
      "Failed requests are retried up to three times by default, with exponential backoff starting at 200 ms. Only idempotent methods are retried unless you opt in with retryUnsafe.",
      "Responses with a 429 status are retried after the delay named in the Retry-After header, which overrides the backoff schedule.",
      "Pass a schema to parse and validate the response body. If validation fails the promise rejects with a SchemaError that carries the offending path.",
      "To send credentials, set the auth option to a function returning a token. It is called before every attempt, so a refreshed token is picked up without recreating the client.",
      "Tessera never logs request bodies or headers. Enable debug mode to log method, URL, status and timing only.",
      "Large downloads can be streamed by setting stream to true, in which case the body is a ReadableStream and is not buffered in memory.",
      "Behind a corporate proxy, set the HTTPS_PROXY environment variable or pass a proxy URL to the client. Proxy authentication uses the URL's username and password.",
      "In tests, replace the transport with the provided mock transport to assert on outgoing requests without opening sockets.",
      "Version 3 drops support for Node 16. The callback API deprecated in version 2 has been removed; use promises.",
      "Uploading files uses multipart form data. Pass a FormData instance as the body and Tessera sets the boundary header for you.",
    ],
    queries: [
      { search: "what happens when the server is too slow to answer", answer: 3 },
      { search: "server says I'm sending too many requests", answer: 5 },
      { search: "how to check the shape of the JSON that comes back", answer: 6 },
      { search: "does it leak my secrets into the console", answer: 8 },
      { search: "my access key expires every hour", answer: 7 },
      { search: "fetching a huge file without running out of RAM", answer: 9 },
      { search: "why shouldn't I make a new instance each call", answer: 2 },
      { search: "faking the network in unit tests", answer: 11 },
      { search: "breaking changes", answer: 12 },
      { search: "will a POST be sent twice if it fails", answer: 4 },
      { search: "websocket support", answer: null },
      { search: "how to draw a bar chart", answer: null },
    ],
  },
  {
    name: "recipe",
    passages: [
      "This pistachio and cardamom loaf cake keeps for days and is better on the second. It came from my grandmother, who made it every spring.",
      "You will need 200 g shelled unsalted pistachios, 180 g butter, 180 g caster sugar, three eggs, 120 g plain flour, a teaspoon of baking powder and the seeds of six cardamom pods.",
      "Heat the oven to 170 °C and line a loaf tin with baking paper, leaving an overhang so the cake can be lifted out.",
      "Blitz the pistachios in a food processor until they resemble coarse sand. Stop before they turn oily and clump together.",
      "Beat the butter and sugar for a full five minutes until pale and fluffy. Add the eggs one at a time with a spoonful of flour to stop the mixture splitting.",
      "Fold in the ground nuts, the remaining flour, baking powder and crushed cardamom. Scrape into the tin and level the top.",
      "Bake for 50 to 55 minutes. A skewer pushed into the centre should come out clean; if the top browns too fast, cover it loosely with foil.",
      "Leave it in the tin for ten minutes, then lift it onto a rack. Do not slice until completely cold or it will crumble.",
      "For the glaze, stir 100 g icing sugar with two tablespoons of lemon juice and pour over the cold cake. Scatter with chopped nuts.",
      "Wrapped well, the cake keeps for five days at room temperature, or three months in the freezer without the glaze.",
      "Ground almonds can replace up to half the pistachios if the budget is tight. For a version without dairy, use the same weight of a mild olive oil and bake five minutes longer.",
      "If your cake sinks in the middle, the oven door was probably opened too early or the raising agent was past its date.",
    ],
    queries: [
      { search: "how do I know when it's done", answer: 6 },
      { search: "can I make it ahead and store it", answer: 9 },
      { search: "vegan-ish substitute for the fat", answer: 10 },
      { search: "what temperature", answer: 2 },
      { search: "why did mine collapse", answer: 11 },
      { search: "cheaper nuts", answer: 10 },
      { search: "shopping list", answer: 1 },
      { search: "the batter curdled", answer: 4 },
      { search: "when can I cut it", answer: 7 },
      { search: "how many calories per slice", answer: null },
      { search: "gluten free flour option", answer: null },
    ],
  },
  {
    name: "news article",
    passages: [
      "The city council voted 7–4 on Tuesday night to close Market Street to private cars from next March, ending a debate that has run for almost a decade.",
      "Buses, taxis, delivery vehicles before 10 a.m. and blue-badge holders will still be allowed through. Everyone else will be diverted onto the ring road.",
      "Supporters pointed to a trial last summer during which footfall in the street's shops rose by 12 per cent and recorded collisions fell to zero.",
      "\"People shop on foot, not from behind a windscreen,\" said councillor Imani Okafor, who proposed the measure. \"The trial proved it.\"",
      "Opponents, led by the Market Street Traders' Association, argued that customers carrying heavy goods would go to the retail park instead. \"We sell furniture, not sandwiches,\" said its chair, Gareth Pugh.",
      "The scheme is expected to cost £2.3 million, most of it for new paving, benches and trees. Two thirds will come from a national active-travel grant, with the remainder borrowed.",
      "Enforcement will be by number-plate cameras. Drivers entering without an exemption face a £70 penalty, halved if paid within two weeks.",
      "Residents of the three streets that can only be reached from Market Street will receive permits free of charge.",
      "The council said it would review the closure after eighteen months and could reverse it if shop vacancy rates rise above the city average.",
      "Cycling groups welcomed the decision but criticised the lack of a segregated lane, saying shared space puts riders in conflict with pedestrians.",
      "Work on the paving is due to begin in January and will be carried out in three phases so that no shop loses access for more than a fortnight.",
    ],
    queries: [
      { search: "what's the fine", answer: 6 },
      { search: "who is paying for it", answer: 5 },
      { search: "could the decision be undone later", answer: 8 },
      { search: "what did the shopkeepers say", answer: 4 },
      { search: "evidence that it works", answer: 2, also: [3] },
      { search: "people who live nearby", answer: 7 },
      { search: "which vehicles are exempt", answer: 1, also: [7] },
      { search: "how close was the vote", answer: 0 },
      { search: "construction schedule", answer: 10 },
      { search: "what bike riders think", answer: 9 },
      { search: "the mayor's resignation", answer: null },
      { search: "house prices", answer: null },
    ],
  },
];
