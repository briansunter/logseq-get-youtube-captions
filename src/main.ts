import "./style.css";
import "@logseq/libs";
import { IHookEvent, SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";
import { getSubtitles } from "youtube-captions-scraper";
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
    key: "youtubeCaptionNewlines",
    type: "boolean",
    default: false,
    title: "Youtube Captions Language",
    description: "Should it put a newline after each caption",
  },
];

logseq.useSettingsSchema(settingsSchema);

async function getCaptions(b: IHookEvent) {
  const captionLanguage = logseq.settings!["youtubeCaptionLanguage"];
  const newlines = logseq.settings!["youtubeCaptionNewlines"];
  let lineSplit = " ";
  if (newlines) {
    lineSplit = "\n";
  }

  try {
    const currentBlock = await logseq.Editor.getBlock(b.uuid);
    if (currentBlock) {
      const { id, service } = getVideoId(currentBlock.content);
      let youtubeId;
      if (service === "youtube") {
        youtubeId = id;
      }

      if (youtubeId) {
        console.log(`getting subtitles for ${youtubeId}`);
        const subs = await getSubtitles({
          videoID: youtubeId,
          lang: captionLanguage,
        });
        if (subs.length > 0) {
          const allSubtitles = subs.map((s) => s.text).join(lineSplit);
          await logseq.Editor.insertBlock(currentBlock.uuid, allSubtitles);
        }
      } else {
        console.warn("no youtube id found in block ${currentBlock.content}");
        logseq.App.showMsg("warn", "No youtube id found in block");
      }
    }
  } catch (e) {
    console.error(e);
    logseq.App.showMsg("error", "Error getting subtitles");
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
