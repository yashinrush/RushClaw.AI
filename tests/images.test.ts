import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildUserContent, extractImageRefs } from "../core/images";
import { tempWorkspace } from "./helpers";

// 1x1 transparent PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

describe("image references", () => {
    test("@path, quoted paths and bare paths are attached", () => {
        const root = tempWorkspace();
        fs.mkdirSync(path.join(root, "shots"));
        fs.writeFileSync(path.join(root, "shots", "bug.png"), PNG);
        fs.writeFileSync(path.join(root, "my screen.jpg"), PNG);

        const r = extractImageRefs(`Fix the layout in @shots/bug.png and "my screen.jpg".`, root);
        expect(r.images.map((i) => i.name)).toEqual(["bug.png", "my screen.jpg"]);
        expect(r.images[1]!.mediaType).toBe("image/jpeg");
        expect(r.text).toBe("Fix the layout in [image: bug.png] and [image: my screen.jpg].");
        expect(r.problems).toEqual([]);
    });

    test("missing @references are reported, bare names are left alone", () => {
        const r = extractImageRefs("see @nope.png and logo.png", tempWorkspace());
        expect(r.images).toHaveLength(0);
        expect(r.problems).toEqual(["nope.png: file not found"]);
        expect(r.text).toBe("see @nope.png and logo.png");
    });

    test("content becomes text + image parts", () => {
        const root = tempWorkspace();
        fs.writeFileSync(path.join(root, "a.png"), PNG);
        const { text, images } = extractImageRefs("what is @a.png", root);
        const content = buildUserContent(text, images) as any[];
        expect(content[0]).toEqual({ type: "text", text: "what is [image: a.png]" });
        expect(content[1].type).toBe("file");
        expect(content[1].mediaType).toBe("image/png");
        expect(buildUserContent("plain", [])).toBe("plain");
    });
});
