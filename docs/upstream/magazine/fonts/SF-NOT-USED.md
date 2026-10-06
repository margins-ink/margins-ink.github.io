# SF Pro (San Francisco) is not used and cannot be embedded

- URL: https://developer.apple.com/fonts/ (page text fetched 2026-10-06 UTC through a page summariser; the licence PDFs themselves were not downloaded, so every quote below is **reported**, not read).
- Licences named on the page: "Apple Inc. License Agreement for the Apple San Francisco Font" (2/24/2016, EA1370, iOS/OS X/tvOS application uses) and the Compact variant (EA1371, watchOS).
- Reported clause, Section 2B: "You may not embed the Apple Font in any software programs or other products." Same section, reported: "Except as expressly provided for herein, you may not use the Apple Font to, create, develop, display or otherwise distribute any documentation, artwork, website content or any other work product."
- Consequence: the site is a WebGPU canvas drawing outline tables compiled from font bytes, which is embedding and website content. A system font stack is no substitute because the shader needs outlines the browser does not expose. Inter (OFL 1.1) is the substitute.
- Status: unverified against the licence PDF text. Before repeating this elsewhere, open the two PDF links on that page and store them here (check their redistribution terms first; if redistribution is forbidden store only the section number and quote).
