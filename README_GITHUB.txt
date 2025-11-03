
Wizard's Den — GitHub Pages Pack
================================

This folder contains:
- index.html         (Hiro marker demo that works immediately — no special files needed)
- index_nft.html     (Advanced AR.js NFT target version — for later)
- assets/            (placeholders)

QUICK START (GitHub Pages)
--------------------------
1) Create a new GitHub repository (e.g., wizard-den-ar).
2) Upload *all files* from this folder into the repository root (including index.html and assets/).
3) Go to: Settings -> Pages -> Build and deployment:
   - Source: "Deploy from a branch"
   - Branch: "main" (or "master")  /  Folder: "/ (root)"
   - Save
4) After a minute, your site will be live at:
   https://<YOUR-USERNAME>.github.io/<YOUR-REPO>/

Test it:
- Open the link on your phone.
- Tap Start, and point your camera at the Hiro marker:
  https://raw.githubusercontent.com/AR-js-org/AR.js/master/three.js/examples/marker-training/examples/pattern-files/hiro.png

WORDPRESS EMBED (works on any plan)
-----------------------------------
Add a Page -> Block: "Custom HTML", then paste:

<iframe src="https://<YOUR-USERNAME>.github.io/<YOUR-REPO>/" width="100%" height="820" style="border:none;"></iframe>

ADVANCED (NFT targets, later)
-----------------------------
- Replace the placeholder files in /assets/targets/grimoire/ with real AR.js NFT files (.iset/.fset/.fset3) generated from your book cover.
- Then either:
  a) Rename index_nft.html to index.html in your repo, OR
  b) Link directly to index_nft.html
