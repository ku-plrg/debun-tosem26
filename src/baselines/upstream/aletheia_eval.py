import argparse
import hashlib
import json
import logging
import os.path

import dolospy

INDEX_DIR = None

PKG_MAPPING = {
  "amplifyjs": "amplifyjs",
  "angular": "@angular/core",
  "angular.js": "angular",
  "backbone.js": "backbone",
  "bootstrap": "bootstrap",
  "camanjs": "caman",
  "can.js": "can",
  "google-closure-library": "google-closure-library",
  "core-js": "core-js",
  "d3": "d3",
  "dc": "dc",
  "dojo": "dojo",
  "fabric.js": "fabric",
  "fastclick": "fastclick",
  "flexslider": "flexslider",
  "flot": "flot",
  "fuse.js": "fuse.js",
  "graphael": "graphael",
  "gsap": "gsap",
  "hammer.js": "hammerjs",
  "handlebars.js": "handlebars",
  "handsontable": "handsontable",
  "headjs": "headjs",
  "highcharts": "highcharts",
  "ifvisible": "ifvisible.js",
  "ionic": "@ionic/cli",
  "jquery.isotope": "isotope-layout",
  "jquery": "jquery",
  "jquery-mobile": "jquery-mobile",
  "jqueryui": "jquery-ui",
  "jquery.ui": "jquery-ui",
  "kendo-ui-core": "kendo-ui-core",
  "knockout": "knockout",
  "labjs": "labjs",
  "leaflet": "leaflet",
  "lodash.js": "lodash-es",
  "mapbox-gl": "mapbox-gl",
  "marionette": "backbone.marionette",
  "material-design-lite": "material-design-lite",
  "matter-js": "matter-js",
  "modernizr": "modernizr",
  "moment-timezone": "moment-timezone",
  "moment.js": "moment",
  "mootools": "mootools",
  "move.js": "move-js",
  "numeral.js": "numeral",
  "paper.js": "paper",
  "pixi.js": "pixi.js",
  "preact": "preact",
  "pusher": "pusher-js",
  "qooxdoo": "@qooxdoo/framework",
  "raphael": "raphael",
  "react-dom": "react",
  "require.js": "requirejs",
  "riot": "riot",
  "sammy.js": "sammy",
  "ScrollMagic": "scrollmagic",
  "seajs": "seajs",
  "socket.io": "socket.io-client",
  "spf": "spf",
  "spinejs": "spine",
  "swfobject": "swfobject",
  "three.js": "three",
  "tween.js": "tween.js",
  "two.js": "two.js",
  "underscore.js": "underscore",
  "velocity": "velocity-react",
  "visibility.js": "visibilityjs",
  "vue": "vue",
  "webfont": "webfontloader",
  "yepnope": "yepnope",
  "yui": "yui",
  "zepto": "zepto"
}

def translate_package_name(cdn: str) -> str:
    return PKG_MAPPING.get(cdn.lower(), cdn.lower())

def sha256(s: str):
    return hashlib.sha256(s.encode(), usedforsecurity=False).hexdigest()

def main():
    logger = logging.getLogger("main")
    parser = argparse.ArgumentParser(description='Evaluate Aletheia')
    parser.add_argument("-o", "--output", type=str, required=True, help="Output filename")
    args = parser.parse_args()

    transform = translate_package_name
    DATASET_PATH = os.path.join("path", "to", "dataset.json")

    with open(DATASET_PATH, "r") as f:
        data = json.load(f)

    result = []
    logger.info("Starting. Total bundles: %s", len(data))

    for i, bundle_data in enumerate(data):
        detections = {}

        for pkg_vers in bundle_data["groundTruth"]:
            if pkg_vers == "three.js@r148":
                pkg_vers = "three.js@0.148.0"

            if "@" not in pkg_vers:  # package without version
                # logger.warning("Skipping %s in %s: no ground truth version", pkg_vers, bundle_data["urls"][0])
                continue
            pkg, vers = pkg_vers.rsplit("@", 1)
            if len(pkg) == 0:  # scoped package without version
                logger.warning("Skipping %s in %s: scoped package without version", pkg_vers, bundle_data["urls"][0])
                continue

            # Load index
            index_file = os.path.join(INDEX_DIR, f"{transform(pkg).replace('/', '+')}.index.json")
            if not os.path.isfile(index_file):
                logger.warning("Skipping %s %s in %s: no index file found at %s", transform(pkg), vers, bundle_data["urls"][0], index_file)
                continue

            with open(index_file) as f:
                index = dolospy.Index.deserialize(f.read())

            # Compute similarities
            pairs = index.matchExternal(bundle_data["source"])
            detections[pkg] = {}
            for pair in pairs:
                detections[pkg][pair.right] = pair.covered / pair.leftTotal if pair.leftTotal > 0 else 0

        # Step 3: Store with response
        result.append({
            "urls": bundle_data["urls"],
            "bundle": sha256(bundle_data["source"]),
            "groundTruth": bundle_data["groundTruth"],
            "detections": detections,
        })

        logger.info(f"Progress: {i+1}/{len(data)}")

    with open(args.output, "w") as f:
        json.dump(result, f)

if __name__ == '__main__':
    INDEX_DIR = os.getenv("INDEX_DIR")

    handler = logging.StreamHandler()
    logging.getLogger("main").setLevel(logging.DEBUG)
    logging.getLogger("main").addHandler(handler)
    main()
