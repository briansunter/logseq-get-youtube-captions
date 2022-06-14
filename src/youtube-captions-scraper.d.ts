declare module "youtube-captions-scraper" {
  import * as YoutubeCaptionsScraper from "youtube-captions-scraper";
  interface Options {
    videoID: string;
    lang?: string;
  }

  interface Caption {
    start: number;
    dur: number;
    text: string;
  }
  export function getSubtitles(Options): Promise<Array<Caption>>;
}
