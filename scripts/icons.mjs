import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFile } from "node:fs/promises";
await sharp("public/art/alpha.svg")
  .resize(512, 512)
  .png()
  .toFile("public/art/alpha.png");
await writeFile("public/art/alpha.ico", await pngToIco("public/art/alpha.png"));
