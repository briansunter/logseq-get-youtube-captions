import "./style.css";
import "@logseq/libs";
import { IHookEvent, SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";
import { getSubtitles } from "youtube-caption-extractor";
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

async function getCaptions(b: IHookEvent) {
  const captionLanguage = logseq.settings!["youtubeCaptionLanguage"];
  const blockSize = logseq.settings!["blockSize"] as number;
  const includeTimestamps = logseq.settings!["includeTimestamps"] as boolean;
  const indentCaptions = logseq.settings!["indentCaptions"] as boolean;
  try {
    const currentBlock = await logseq.Editor.getBlock(b.uuid);
    if (!currentBlock) {
      console.warn("no youtube id found in block ${currentBlock.content}");
      logseq.App.showMsg("No youtube id found in block", "warning");
      return;
    }

    const { id, service } = getVideoId(currentBlock.content);
    let youtubeId;

    if (service === "youtube") {
      youtubeId = id;
    }

    if (!youtubeId) {
      console.warn("no youtube id found in block ${currentBlock.content}");
      logseq.App.showMsg("No youtube id found in block", "warning");
      return;
    }

    // remove }} in string
    const youtubeIdWithoutTimestamp = youtubeId.replace("}}", "");
    console.log(`getting subtitles for ${youtubeIdWithoutTimestamp}`);

    const subs = await getSubtitles({
      videoID: youtubeIdWithoutTimestamp,
      lang: captionLanguage,
    });

    if (subs.length === 0) {
      console.warn(`no subtitles found for ${youtubeId}`);
      logseq.App.showMsg(`No subtitles found for ${youtubeId}`, "warning");
      return;
    }

    const captions = [];
    let currentCaption = "";
    for (const sub of subs) {
      const currentTime = Math.floor(Number.parseInt(sub.start));
      let logseqYoutubeTimestamp = "";
      if (includeTimestamps) {
        logseqYoutubeTimestamp = `{{youtube-timestamp ${currentTime}}} `;
      }

      if (currentCaption.length === 0) {
        currentCaption += logseqYoutubeTimestamp;
      }

      const noNewlineText = sub.text.replace(/\n/g, " ");

      if (currentCaption.length + noNewlineText.length < blockSize) {
        currentCaption += noNewlineText + " ";
      } else {
        captions.push(currentCaption);
        currentCaption = logseqYoutubeTimestamp + noNewlineText + " ";
      }
    }

    if (currentCaption.length > 0) {
      captions.push(currentCaption);
    }

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
  logseq.Editor.registerBlockContextMenuItem(
    "get-youtube-captions",
    getCaptions
  );

  logseq.Editor.registerSlashCommand("get-youtube-captions", getCaptions);
}

logseq.ready(main).catch(console.error);
