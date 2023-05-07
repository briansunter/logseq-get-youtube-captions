import "./style.css";
import "@logseq/libs";
import { IHookEvent, SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";
import { getSubtitles, Caption } from "youtube-captions-scraper";
import getVideoId from "get-video-id";

const settingsSchema: SettingSchemaDesc[] = [
  {
    key: "youtubeCaptionLanguage",
    type: "string",
    default: "en",
    title: "Youtube Captions Language",
    description:
      "What language to get captions in. en, es, fr , de etc. See https://wp-info.org/tools/languagecodes.php.<br/>You can also specify multiple languages separated by commas.",
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

    console.log(`getting subtitles for ${youtubeId}`);

    const subs = await getSubtitlesMultiLanguage(youtubeId, captionLanguage);

    if (subs.length === 0) {
      console.warn(`no subtitles found for ${youtubeId}`);
      logseq.App.showMsg(`No subtitles found for ${youtubeId}`, "warning");
      return;
    }

    const captions = [];
    let currentCaption = "";
    for (const sub of subs) {
      const currentTime = Math.floor(sub.start);
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

  async function getSubtitlesMultiLanguage(youtubeId: string, languages: string) : Promise<Caption[]> {
    let listOfLanguages: string[] = languages.split(",").map((lang: string) => lang.trim());
    let subs: Caption[] = [];
    let errors = [];
    for (const lang of listOfLanguages) {
      try {
        subs = await getSubtitles({
          videoID: youtubeId,
          lang: lang,
        });
        if (subs.length > 0) {
          break;
        }
      } catch (e) {
        console.error(e);
        errors.push(e);
      }
    }

    if (subs.length === 0 &&  errors.length > 0) {
      for (const e of errors) {
        if (e instanceof Error) {
          logseq.App.showMsg(`Error getting subtitles: ${e.message}`, "error");
        } else {
          logseq.App.showMsg(`Unknown Error getting subtitles`, "error");
        }
      }
    }  
    
    return subs;
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
