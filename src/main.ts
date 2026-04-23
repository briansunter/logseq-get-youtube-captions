import "./style.css";
import "@logseq/libs";
import { IHookEvent, SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";
import getVideoId from "get-video-id";

const settingsSchema: SettingSchemaDesc[] = [
  {
    key: "youtubeCaptionLanguage",
    type: "string",
    default: "en",
    title: "Youtube Captions Language",
    description:
      "What langauge to get captions in. en, es, fr , de etc. See https://wp-info.org/tools/languagecodes.php",
  },
  {
    key: "blockSize",
    type: "number",
    default: 1000,
    title: "Block size",
    description: "How many characters to put in each block",
  },
  {
    key: "includeTimestamps",
    type: "boolean",
    default: true,
    title: "Include Timestamps",
    description:
      "Should include a {{youtube-timestamp}} link in the caption blocks.",
  },
  {
    key: "indentCaptions",
    type: "boolean",
    default: true,
    title: "Indent captions",
    description:
      "Should indent the captions so they are indented under the youtube block.",
  },
];

logseq.useSettingsSchema(settingsSchema);

// ---- YouTube transcript extraction ----

interface Subtitle {
  start: string;
  dur: string;
  text: string;
}

function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

// Node.js https helper - makes raw HTTP requests bypassing browser restrictions
function nodeHttpsRequest(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let https: any;
    try {
      // Try to access Node.js https via parent (Logseq main window has nodeIntegration)
      https = (parent as any).require?.("https") || (top as any).require?.("https") || (window as any).require?.("https");
    } catch {}
    if (!https) {
      try {
        // Try global require
        https = (globalThis as any).require?.("https");
      } catch {}
    }
    if (!https) {
      reject(new Error("Node.js https not available"));
      return;
    }

    const parsed = new URL(url);
    const reqOptions: any = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options?.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options?.headers || {}),
      },
    };

    const req = https.request(reqOptions, (res: any) => {
      let body = "";
      res.on("data", (chunk: any) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

// Check if Node.js https is available
function hasNodeHttps(): boolean {
  try {
    const m = (parent as any).require?.("https") || (top as any).require?.("https") || (window as any).require?.("https") || (globalThis as any).require?.("https");
    return !!m;
  } catch {
    return false;
  }
}

async function getSubtitles(videoId: string, lang: string): Promise<Subtitle[]> {
  // Check if we have Node.js access (bypasses all browser restrictions)
  const nodeAvailable = hasNodeHttps();
  console.log(`[yt-captions] Node.js https available: ${nodeAvailable}`);

  if (nodeAvailable) {
    try {
      const subs = await getSubtitlesViaNode(videoId, lang);
      if (subs.length > 0) return subs;
    } catch (e) {
      console.log(`[yt-captions] Node.js approach failed:`, e);
    }
  }

  // Browser fetch approach
  console.log(`[yt-captions] Fetching watch page for ${videoId}`);
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: "include",
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!resp.ok) throw new Error(`Watch page fetch failed: ${resp.status}`);
  const html = await resp.text();
  console.log(`[yt-captions] Watch page: ${html.length} chars`);

  const config = extractConfig(html);
  console.log(`[yt-captions] Config: apiKey=${config.apiKey}, version=${config.clientVersion}`);

  // APPROACH 1: /get_transcript WITHOUT visitorData (avoids cookie/visitor mismatch)
  const initialDataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (initialDataMatch) {
    try {
      const ytData = JSON.parse(initialDataMatch[1]);
      const result = extractTranscriptFromInitialData(ytData, lang);
      if (result.subtitles.length > 0) return result.subtitles;

      if (result.continuationParams) {
        // Try with bare minimum client context (no visitorData = no mismatch)
        const bareClients = [
          { name: "bare-web", client: { clientName: "WEB", clientVersion: config.clientVersion } },
          { name: "android", client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 } },
          { name: "ios", client: { clientName: "IOS", clientVersion: "20.10.38" } },
          { name: "tv", client: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0" } },
        ];

        for (const { name, client } of bareClients) {
          try {
            console.log(`[yt-captions] Trying /get_transcript with ${name} client (no visitorData)...`);
            const gtResp = await fetch(
              `https://www.youtube.com/youtubei/v1/get_transcript?key=${config.apiKey}`,
              {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  context: { client: { hl: lang || "en", gl: "US", ...client } },
                  params: result.continuationParams,
                }),
              }
            );
            if (gtResp.ok) {
              const data = await gtResp.json();
              const subs = extractTranscriptFromResponse(data);
              if (subs.length > 0) {
                console.log(`[yt-captions] ${name} client succeeded! ${subs.length} subtitles`);
                return subs;
              }
              console.log(`[yt-captions] ${name}: OK but no segments`);
            } else {
              const err = await gtResp.text();
              console.log(`[yt-captions] ${name}: ${gtResp.status} - ${err.substring(0, 100)}`);
            }
          } catch (e) {
            console.log(`[yt-captions] ${name} error:`, e);
          }
        }
      }
    } catch (e) {
      console.log(`[yt-captions] ytInitialData parse error:`, e);
    }
  }

  // APPROACH 2: ANDROID client /player → get timedtext URLs without POT requirement
  console.log(`[yt-captions] Trying ANDROID /player for POT-free timedtext...`);
  try {
    const playerResp = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${config.apiKey}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
              androidSdkVersion: 30,
              hl: lang || "en",
              gl: "US",
            },
          },
          videoId,
        }),
      }
    );
    if (playerResp.ok) {
      const playerData = await playerResp.json();
      const status = playerData?.playabilityStatus?.status;
      console.log(`[yt-captions] ANDROID /player status: ${status}`);
      const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        console.log(`[yt-captions] ANDROID tracks: ${tracks.map((t: any) => t.languageCode)}`);
        const subs = await fetchTimedtext(tracks, lang);
        if (subs.length > 0) {
          console.log(`[yt-captions] ANDROID timedtext succeeded! ${subs.length} subtitles`);
          return subs;
        }
      } else {
        console.log(`[yt-captions] ANDROID /player: no caption tracks`);
      }
    } else {
      console.log(`[yt-captions] ANDROID /player failed: ${playerResp.status}`);
    }
  } catch (e) {
    console.log(`[yt-captions] ANDROID /player error:`, e);
  }

  // APPROACH 3: WEB timedtext from watch page (needs POT - likely fails)
  const playerMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (playerMatch) {
    try {
      const playerData = JSON.parse(playerMatch[1]);
      const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        console.log(`[yt-captions] WEB tracks: ${tracks.map((t: any) => t.languageCode)}`);
        const subs = await fetchTimedtext(tracks, lang);
        if (subs.length > 0) return subs;
      }
    } catch (e) {
      console.log(`[yt-captions] WEB timedtext failed:`, e);
    }
  }

  return [];
}

// Full caption fetch via Node.js https (no browser restrictions)
async function getSubtitlesViaNode(videoId: string, lang: string): Promise<Subtitle[]> {
  console.log(`[yt-captions] [Node] Fetching watch page...`);

  // Step 1: Fetch watch page to get config
  const html = await nodeHttpsRequest(`https://www.youtube.com/watch?v=${videoId}`);
  console.log(`[yt-captions] [Node] Watch page: ${html.length} chars`);

  const config = extractConfig(html);
  console.log(`[yt-captions] [Node] Config: apiKey=${config.apiKey}, version=${config.clientVersion}`);

  // Step 2: Try to get captions from timedtext (via Node, no cookie issues)
  const playerMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (playerMatch) {
    try {
      const playerData = JSON.parse(playerMatch[1]);
      const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        const track = tracks.find((t: any) => t.languageCode === lang) || tracks[0];
        if (track?.baseUrl) {
          console.log(`[yt-captions] [Node] Fetching timedtext for track: ${track.languageCode}`);
          const baseUrlClean = track.baseUrl.replace(/&fmt=[^&]*/, "");
          // Try json3 format first
          try {
            const json3Text = await nodeHttpsRequest(baseUrlClean + "&fmt=json3");
            if (json3Text && json3Text.length > 0) {
              console.log(`[yt-captions] [Node] Timedtext json3: ${json3Text.length} chars`);
              const json3 = JSON.parse(json3Text);
              if (json3.events) {
                const subs = parseJson3Events(json3.events);
                if (subs.length > 0) {
                  console.log(`[yt-captions] [Node] Got ${subs.length} subtitles from timedtext!`);
                  return subs;
                }
              }
            }
          } catch (e) {
            console.log(`[yt-captions] [Node] Timedtext json3 error:`, e);
          }
          // Try XML format
          try {
            const xmlText = await nodeHttpsRequest(baseUrlClean);
            if (xmlText && xmlText.length > 0 && xmlText.includes("<text")) {
              console.log(`[yt-captions] [Node] Timedtext XML: ${xmlText.length} chars`);
              const subs = parseXmlCaptions(xmlText);
              if (subs.length > 0) return subs;
            }
          } catch (e) {
            console.log(`[yt-captions] [Node] Timedtext XML error:`, e);
          }
        }
      }
    } catch (e) {
      console.log(`[yt-captions] [Node] Player parse error:`, e);
    }
  }

  // Step 3: Try /get_transcript via Node.js (no browser Origin header = might work)
  const initialDataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (initialDataMatch) {
    try {
      const ytData = JSON.parse(initialDataMatch[1]);
      const result = extractTranscriptFromInitialData(ytData, lang);
      if (result.subtitles.length > 0) return result.subtitles;

      if (result.continuationParams) {
        console.log(`[yt-captions] [Node] Trying /get_transcript...`);
        const body = JSON.stringify({
          context: {
            client: {
              hl: lang || "en",
              gl: "US",
              clientName: "WEB",
              clientVersion: config.clientVersion,
              visitorData: config.visitorData,
            },
          },
          params: result.continuationParams,
        });

        const gtResp = await nodeHttpsRequest(
          `https://www.youtube.com/youtubei/v1/get_transcript?key=${config.apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Visitor-Id": config.visitorData || "",
            },
            body,
          }
        );

        if (gtResp && gtResp.length > 0) {
          console.log(`[yt-captions] [Node] /get_transcript response: ${gtResp.length} chars`);
          const data = JSON.parse(gtResp);
          const subs = extractTranscriptFromResponse(data);
          if (subs.length > 0) {
            console.log(`[yt-captions] [Node] Got ${subs.length} subtitles from /get_transcript!`);
            return subs;
          }
        }
      }
    } catch (e) {
      console.log(`[yt-captions] [Node] get_transcript error:`, e);
    }
  }

  return [];
}

interface TranscriptResult {
  subtitles: Subtitle[];
  continuationParams?: string;
}

function extractTranscriptFromInitialData(ytData: any, _lang: string): TranscriptResult {
  const panels = ytData?.engagementPanels;
  if (!panels || !Array.isArray(panels)) return { subtitles: [] };

  for (const panel of panels) {
    const panelId = panel?.engagementPanelSectionListRenderer?.panelIdentifier;
    if (panelId !== "engagement-panel-searchable-transcript") continue;

    console.log(`[yt-captions] Found transcript engagement panel`);
    const content = panel.engagementPanelSectionListRenderer?.content;

    // Check if transcript segments are directly embedded
    const sectionContents = content?.sectionListRenderer?.contents;
    if (sectionContents) {
      for (const section of sectionContents) {
        const segments = section?.transcriptRenderer?.content
          ?.transcriptSearchPanelRenderer?.body
          ?.transcriptSegmentListRenderer?.initialSegments;
        if (segments && segments.length > 0) {
          console.log(`[yt-captions] Found ${segments.length} embedded transcript segments`);
          return { subtitles: parseTranscriptSegments(segments) };
        }
      }
    }

    // Extract continuation params from getTranscriptEndpoint
    if (content?.continuationItemRenderer) {
      const endpoint = content.continuationItemRenderer?.continuationEndpoint;
      const params = endpoint?.getTranscriptEndpoint?.params;
      if (params) {
        console.log(`[yt-captions] Found getTranscriptEndpoint params (${params.length} chars)`);
        return { subtitles: [], continuationParams: params };
      }
    }
  }

  return { subtitles: [] };
}


function parseTranscriptSegments(segments: any[]): Subtitle[] {
  const subtitles: Subtitle[] = [];
  for (const segment of segments) {
    const renderer = segment?.transcriptSegmentRenderer;
    if (!renderer) continue;

    const startMs = parseInt(renderer.startMs || "0");
    const endMs = parseInt(renderer.endMs || "0");
    const text = renderer.snippet?.runs?.map((r: any) => r.text).join("") || "";

    if (text.trim()) {
      subtitles.push({
        start: (startMs / 1000).toString(),
        dur: ((endMs - startMs) / 1000).toString(),
        text: decodeHtmlEntities(text.replace(/<[^>]+>/g, "")),
      });
    }
  }
  return subtitles;
}


function extractTranscriptFromResponse(data: any): Subtitle[] {
  // Path 1: actions → updateEngagementPanelAction
  const segments1 = data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer
    ?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
  if (segments1 && segments1.length > 0) return parseTranscriptSegments(segments1);

  // Path 2: continuationContents
  const segments2 = data?.actions?.[0]?.updateEngagementPanelAction?.content
    ?.continuationContents?.transcriptSearchPanelRenderer?.body
    ?.transcriptSegmentListRenderer?.initialSegments;
  if (segments2 && segments2.length > 0) return parseTranscriptSegments(segments2);

  return [];
}

async function fetchTimedtext(tracks: any[], lang: string): Promise<Subtitle[]> {
  const track = tracks.find((t: any) => t.languageCode === lang) ||
    tracks.find((t: any) => t.vssId?.includes(`.${lang}`)) ||
    tracks[0];

  if (!track?.baseUrl) {
    console.log(`[yt-captions] No suitable track found`);
    return [];
  }

  console.log(`[yt-captions] Trying track: ${track.languageCode} (${track.vssId})`);
  console.log(`[yt-captions] Track baseUrl: ${track.baseUrl.substring(0, 100)}...`);

  const baseUrlClean = track.baseUrl.replace(/&fmt=[^&]*/, "");
  const urls = [
    baseUrlClean + "&fmt=json3",
    baseUrlClean,
  ];
  if (track.languageCode !== lang) {
    urls.unshift(baseUrlClean + `&fmt=json3&tlang=${lang}`);
  }

  // Try each URL with different credential modes
  for (const url of urls) {
    for (const creds of ["include", "omit"] as RequestCredentials[]) {
      try {
        console.log(`[yt-captions] Fetching timedtext (credentials=${creds})...`);
        const resp = await fetch(url, {
          credentials: creds,
          headers: {
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        console.log(`[yt-captions] Timedtext response: status=${resp.status}, type=${resp.type}, url=${resp.url.substring(0, 80)}...`);

        // Log response headers
        const contentType = resp.headers.get("content-type");
        const contentLength = resp.headers.get("content-length");
        const cors = resp.headers.get("access-control-allow-origin");
        console.log(`[yt-captions] Timedtext headers: content-type=${contentType}, content-length=${contentLength}, cors=${cors}`);

        if (!resp.ok) {
          console.log(`[yt-captions] Timedtext not OK: ${resp.status} ${resp.statusText}`);
          continue;
        }
        const text = await resp.text();
        if (!text || text.length === 0) {
          console.log(`[yt-captions] Timedtext response body empty`);
          continue;
        }
        console.log(`[yt-captions] Timedtext response: ${text.length} chars, first 200: ${text.substring(0, 200)}`);

        // Try JSON3 format
        try {
          const json3 = JSON.parse(text);
          if (json3.events) {
            const subs = parseJson3Events(json3.events);
            if (subs.length > 0) return subs;
          }
        } catch {}

        // Try XML format
        if (text.includes("<text")) {
          const subs = parseXmlCaptions(text);
          if (subs.length > 0) return subs;
        }
      } catch (e) {
        console.log(`[yt-captions] Timedtext fetch error (credentials=${creds}):`, e);
      }
    }
  }

  return [];
}

function parseJson3Events(events: any[]): Subtitle[] {
  const subtitles: Subtitle[] = [];
  for (const event of events) {
    if (event.segs && event.tStartMs !== undefined) {
      const text = event.segs.map((s: any) => s.utf8 || "").join("");
      if (text.trim() && text.trim() !== "\n") {
        subtitles.push({
          start: (event.tStartMs / 1000).toString(),
          dur: ((event.dDurationMs || 0) / 1000).toString(),
          text: text.trim(),
        });
      }
    }
  }
  return subtitles;
}

function parseXmlCaptions(xml: string): Subtitle[] {
  const subtitles: Subtitle[] = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, ""));
    if (text.trim()) {
      subtitles.push({
        start: match[1],
        dur: match[2],
        text: text.trim(),
      });
    }
  }
  return subtitles;
}

function extractConfig(html: string) {
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  const visitorMatch = html.match(/"visitorData":"([^"]+)"/);
  return {
    apiKey: apiKeyMatch?.[1] || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    clientVersion: versionMatch?.[1] || "2.20260301.01.00",
    visitorData: visitorMatch?.[1] || "",
  };
}

// ---- Plugin logic ----

async function getCaptions(b: IHookEvent) {
  const captionLanguage = logseq.settings?.["youtubeCaptionLanguage"] || "en";
  const blockSize = (logseq.settings?.["blockSize"] as number) || 1000;
  const includeTimestamps = logseq.settings?.["includeTimestamps"] !== false;
  const indentCaptions = logseq.settings?.["indentCaptions"] !== false;

  try {
    const currentBlock = await logseq.Editor.getBlock(b.uuid);
    if (!currentBlock) {
      logseq.App.showMsg("No youtube id found in block", "warning");
      return;
    }

    const { id, service } = getVideoId(currentBlock.content);
    let youtubeId: string | undefined;
    if (service === "youtube") youtubeId = id ?? undefined;

    if (!youtubeId) {
      logseq.App.showMsg("No youtube id found in block", "warning");
      return;
    }

    const youtubeIdClean = youtubeId.replace("}}", "");
    console.log(`[yt-captions] Getting subtitles for ${youtubeIdClean}`);

    const subs = await getSubtitles(youtubeIdClean, captionLanguage);

    if (subs.length === 0) {
      logseq.App.showMsg(`No subtitles found for ${youtubeId}`, "warning");
      return;
    }

    console.log(`[yt-captions] Success! ${subs.length} subtitles`);

    const captions: string[] = [];
    let currentCaption = "";
    for (const sub of subs) {
      const currentTime = Math.floor(Number.parseInt(sub.start));
      let ts = "";
      if (includeTimestamps) ts = `{{youtube-timestamp ${currentTime}}} `;
      if (currentCaption.length === 0) currentCaption += ts;
      const noNewline = sub.text.replace(/\n/g, " ");
      if (currentCaption.length + noNewline.length < blockSize) {
        currentCaption += noNewline + " ";
      } else {
        captions.push(currentCaption);
        currentCaption = ts + noNewline + " ";
      }
    }
    if (currentCaption.length > 0) captions.push(currentCaption);

    const subtitleBlocks = captions.map((content) => ({ content }));
    await logseq.Editor.insertBatchBlock(currentBlock.uuid, subtitleBlocks, {
      sibling: !indentCaptions,
    });
  } catch (e) {
    console.error(e);
    if (e instanceof Error) {
      logseq.App.showMsg(`Error getting subtitles: ${e.message}`, "error");
    } else {
      logseq.App.showMsg(`Unknown Error getting subtitles`, "error");
    }
  }
}

async function main() {
  logseq.Editor.registerBlockContextMenuItem("get-youtube-captions", getCaptions);
  logseq.Editor.registerSlashCommand("get-youtube-captions", getCaptions);
}

logseq.ready(main).catch(console.error);
