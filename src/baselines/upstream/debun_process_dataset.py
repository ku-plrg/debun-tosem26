import json
import os.path
import re
from dataclasses import dataclass
from itertools import groupby
from typing import Optional


@dataclass
class GroundTruthEntry:
    domain: str
    package: str
    version: Optional[str]
    path: str

def parse_ground_truth(line: str) -> GroundTruthEntry:
    # Pattern: domain.md:line_number:package | version | `path`
    match = re.match(
        r'([^:]+)\.md:\d+:(\S+)\s*\|\s*(.+?)\s*\|\s*`([^`]+)`',
        line
    )

    if not match:
        raise ValueError(f"Could not parse line: {line}")

    domain, package, version, path = match.groups()

    # Convert empty version string to None
    version = version.strip() if version.strip() else None

    return GroundTruthEntry(
        domain=domain,
        package=package,
        version=version,
        path=path
    )

# grep -rnE '^[@a-zA-Z0-9._-]{2,} ?\|' | grep -vE '(--- |Library )' | sort
INPUT = """aldi.us.md:165:moment | 2.29.4 | `www.aldi.us/typo3temp/assets/compressed/merged-33b86cc73850043b092521502f0cbd2b-min.1740636184.js`
aldi.us.md:5:Modernizr | 3.6.0 | `www.aldi.us/typo3temp/assets/compressed/merged-6cc790d9e070f30851ecc949b7cb5bab-min.1740636184.js`
allrecipes.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
allrecipes.com.md:87:jquery | 3.6.0 | `www.allrecipes.com/static/3.0.0/cache/eNqdVGuS2yAMvlAZZs-wf3sJGWSsVkBW4CTO6Stsz26ycWmmM3HQ60PoaUuFSs5GSJXR7hzTUOwv_X3MKMsP-2ikirkSUyUsZpiJq7lQncxfraMS5gyJmMEUJ5n5u5XL8ZQTplospYqSgK3HEaXhV0LQf4GynxnLParK1cA46rOgoqkQAsoujXDL6UnZL.js`
amazon.com.md:338:core-js |  | `images-na.ssl-images-amazon.com/images/I/51na2k2njbL._RC%7C71uK9RCm7xL.js,01QvReFeJyL.js,01kNZEEDitL.js,71zaoacXuRL.js,41jBieyCvYL.js,01wXnKULArL.js,01+pnQJuQ0L.js,21PMP-WgxTL.js,41lXbNNGwGL.js,51HrkAbbpLL.js,31XO9BO1OrL.js,11lw6J`
amazon.com.md:5:jquery | 1.6.4 | `m.media-amazon.com/images/I/61xJcNKKLXL.js?AUIClients/AmazonUIjQuery`
apnews.com.md:211:lodash.js |  | `cdn.optimizely.com/js/26780310980.js`
apnews.com.md:5:core-js |  | `s.ntv.io/serve/load.js`
apnews.com.md:78:jquery | 1.11.2 | `apcdp.apnews.com/plugin/library/4d4ff48020e0349f90f1558ad1745b6f`
apple.com.md:1144:preact | 10.10.6 | `www.apple.com/api-www/global-elements/global-header/v1/assets/globalheader.umd.js`
apple.com.md:252:zepto |  | `www.apple.com/metrics/ac-target/latest/ac-target.js`
apple.com.md:5:handlebars.js | 4.7.7 | `www.apple.com/ac/localeswitcher/4/en_US/scripts/localeswitcher.built.js`
bankofamerica.com.md:217:jquery | 3.7.1 | `www1.bac-assets.com/spa/widgets/global-search-public-widget/2.0.0/spa-assets/js/common-chunks/common-es6-components-e93f13cea47f3667f9e2.m.js`
bankofamerica.com.md:461:lodash.js | 4.17.21 | `www1.bac-assets.com/spa/widgets/global-search-public-widget/2.0.0/spa-assets/js/common-chunks/common-es6-components-e93f13cea47f3667f9e2.m.js`
bankofamerica.com.md:5:handlebars | 4.7.8 | `www1.bac-assets.com/spa/widgets/global-search-public-widget/2.0.0/spa-assets/js/common-chunks/common-es6-components-e93f13cea47f3667f9e2.m.js`
bbc.com.md:10163:core-js | 3.10.2 | `cdn.privacy-mgmt.com/unified/wrapperMessagingWithoutDetection.js`
bbc.com.md:10321:ifvisible |  | `cdn.tinypass.com/api/tinypass.min.js`
bbc.com.md:10601:require.js | 2.0.5 | `static.bbci.co.uk/frameworks/requirejs/0.13.0/sharedmodules/require.js`
bbc.com.md:5:react |  | `www.bbc.com/bbcx/_next/static/chunks/framework-98e6f5bc52a2e411.js`
bbc.com.md:8438:lodash.js |  | `www.bbc.com/bbcx/_next/static/chunks/pages/_app-218c7e1066faef49.js`
bbc.com.md:8588:lodash.js | 4.6.1 | `cdn.optimizely.com/public/4621041136/s/bbcx_prod.js`
britannica.com.md:10654:lodash.js |  | `cdn.britannica.com/mendel-resources/3-133/dist/home-page.js%3Fv%3D3.133.36`
britannica.com.md:10762:zepto |  | `cdn.britannica.com/mendel-resources/3-133/js/at.js%3Fv%3D3.133.36`
britannica.com.md:1865:webfont |  | `cdn.jifo.co/js/dist/embed_flex_viewer-9f95a0c8f0857ec47357-1-webpack.js`
britannica.com.md:1988:backbone | 1.2.3 | `cdn.jifo.co/js/dist/bundle_vendor-e1f90d2f52a6509a2171-1-webpack.js`
britannica.com.md:211:moment.js | 2.24.0 | `cdn.jifo.co/js/dist/bundle_vendor-e1f90d2f52a6509a2171-1-webpack.js`
britannica.com.md:3204:core-js | 3.1.3 | `cdn.jifo.co/js/dist/embed_flex_viewer-9f95a0c8f0857ec47357-1-webpack.js`
britannica.com.md:3350:jQuery |  | `cdn.jifo.co/js/dist/bundle_vendor-e1f90d2f52a6509a2171-1-webpack.js`
britannica.com.md:5:React | 17.0.2 | `cdn.jifo.co/js/dist/bundle_vendor-e1f90d2f52a6509a2171-1-webpack.js`
britannica.com.md:9575:lodash.js |  | `cdn.jifo.co/js/dist/bundle_vendor-e1f90d2f52a6509a2171-1-webpack.js`
ca.gov.md:5:bootstrap | 5.3.3 | `cdn.cdt.ca.gov/cdt/statetemplate/6.4.2/js/cagov.core.min.js`
cbsnews.com.md:194:react | 17.0.2 | `disco.headliner.link/d/cbsnews/web/js/widget.js`
cbsnews.com.md:305:require.js | 2.3.5 | `www.cbsnews.com/fly/bundles/cbsnewscore/js-build/main.js%3Fv%3D8de240724d7f6d8b5f54f62bb158c012`
cbsnews.com.md:464:riot | 3.13.2 | `www.cbsnews.com/fly/bundles/cbsnewscore/js-build/main.video-embed.js%3Fv%3D8de240724d7f6d8b5f54f62bb158c012`
cbsnews.com.md:5:core-js | 3.40.0 | `at.cbsi.com/lib/dist/prod/bidbarrel-cbsnews.min.js%3Fv%3D8de240724d7f6d8b5f54f62bb158c012`
cbsnews.com.md:86:google-closure-library |  | `imasdk.googleapis.com/js/sdkloader/ima3_dai_debug.js`
cbssports.com.md:136:jquery | 1.8.3 | `sportsfly.cbsistatic.com/fly-0891/bundles/sportsmediajs/js-build/jquery.js`
cbssports.com.md:282:lodash.js | 4.6.1 | `cdn.optimizely.com/js/20675180171.js`
cbssports.com.md:578:modernizr | 2.6.2 | `sportsfly.cbsistatic.com/fly-0891/bundles/sportsmediajs/js-build/main.desktop.js`
cbssports.com.md:5:core-js | 3.40.0 | `at.cbsi.com/lib/dist/prod/bidbarrel-cbssports.min.js`
cbssports.com.md:753:react | 18.2.0 | `www.cbssports.com/_next/static/chunks/main-b31503ca6016de48.js`
cbssports.com.md:902:require.js | 2.3.5 | `sportsfly.cbsistatic.com/fly-0891/bundles/sportsmediajs/js-build/libs/require-2.3.5.js`
cdc.gov.md:18:jquery | 3.7.1 | `www.cdc.gov/TemplatePackage/contrib/libs/jquery/latest/jquery.js%3F_%3D82471`
cdc.gov.md:5:bootstrap | 5.3.3 | `www.cdc.gov/TemplatePackage/contrib/libs/bootstrap/5x/bootstrap.bundle.min.js%3F_%3D82471`
chase.com.md:254:require.js | 2.1.15 | `www.chase.com/c/020525/etc/designs/chase-ux/clientlibs/require/js/require.min.js`
chase.com.md:395:underscore.js | 1.8.3 | `www.chase.com/c/020525/etc/designs/chase-ux/clientlibs/chase-ux/js/dist/index.min.js`
chase.com.md:502:zepto | 2.10.0 | `www.chase.com/c/020525/etc/designs/chase-ux/clientlibs/chase-ux/js/dist/index.min.js`
chase.com.md:5:jquery | 1.12.2 | `www.chase.com/c/020525/etc/designs/chase-ux/clientlibs/jquery/js/jquery.min.js`
clevelandclinic.org.md:137:lodash.js | 3.10.1 | `cdn.heapanalytics.com/js/heap-1538774254.js`
clevelandclinic.org.md:5:jquery | 3.0.0 | `code.jquery.com/jquery-3.0.0.min.js`
craigslist.org.md:268:jquery-ui | 1.14.1 | `www.craigslist.org/static/www/browsePostings-2025-02-19-12-46-ed669cbe89d9fe3a601ba3e7e2490e618fa7bed7.js`
craigslist.org.md:5:jquery | 3.7.1 | `www.craigslist.org/static/www/browsePostings-2025-02-19-12-46-ed669cbe89d9fe3a601ba3e7e2490e618fa7bed7.js`
craigslist.org.md:661:leaflet | 1.6.0 | `www.craigslist.org/static/www/browsePostings-2025-02-19-12-46-ed669cbe89d9fe3a601ba3e7e2490e618fa7bed7.js`
dictionary.com.md:112:lodash.js |  | `player.anyclip.com/anyclip-widget/lre-widget/prod/v1/src/lre.js`
dictionary.com.md:228:react | 18.2.0 | `www.dictionary.com/vendor.6ca7aab4.js`
dictionary.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
ebay.com.md:211:jquery.ui | 1.10.2 | `ir.ebaystatic.com/cr/v/c01/ac-022425204313.dweb-old.min.js`
ebay.com.md:429:lodash.js | 4.17.21 | `ir.ebaystatic.com/rs/c/vertlandweb/r.e9fbc13c.js`
ebay.com.md:5:jquery | 3.7.0 | `secureir.ebaystatic.com/cr/v/c1/jquery/jquery-3.7.0.min.js`
ebay.com.md:645:react | 17.0.2 | `www.ebay.com/ifh/ifh-vendor47b7e946f0ac844e241f.js`
eightsleep.com.md:11160:core-js | 3.1.3 | `static.fbot.me/friendbuy.js`
eightsleep.com.md:11233:lodash.js |  | `static.fbot.me/friendbuy.js`
eightsleep.com.md:11328:gsap | 3.12.5 | `www.eightsleep.com/_next/static/chunks/7449-a6763fc2b0b70a6e.js`
eightsleep.com.md:14328:jquery | 3.6.3 | `j.northbeam.io/ota-sp/e76eae04-c01f-430c-a6f3-49eacea424d6.js`
eightsleep.com.md:20300:preact |  | `static.klaviyo.com/onsite/js/vendors~in_app_forms~signup_forms~reviews~atlas.021c21b9986168e359dc.js%3Fcb%3D1`
eightsleep.com.md:21726:three.js |  | `www.eightsleep.com/_next/static/chunks/b536a0f1-137235b0131a0142.js`
eightsleep.com.md:489:React |  | `decagon.ai/_next/static/chunks/fd9d1056-2c472b416fe1132d.js`
eightsleep.com.md:5:moment.js | 2.30.1 | `www.eightsleep.com/_next/static/chunks/13b76428-0ce2eef085c36441.js`
espn.com.md:1048:moment.js | 2.13.0 | `a.espncdn.com/redesign/0.719.1/js/espn-defer.js`
espn.com.md:1216:zepto |  | `a.espncdn.com/prod/scripts/analytics/ESPN_at_v2.rs.min.js`
espn.com.md:1322:react |  | `a.espncdn.com/redesign/0.719.1/js/personalized-one-feed.min.js`
espn.com.md:150:core-js | 2.5.0 | `a.espncdn.com/redesign/0.719.1/js/personalized-one-feed.min.js`
espn.com.md:271:flot | 0.8.3 | `a.espncdn.com/redesign/0.719.1/js/espn-defer.js`
espn.com.md:473:jquery | 2.2.2 | `a.espncdn.com/redesign/0.719.1/js/espn-critical.js`
espn.com.md:5:backbone.js | 1.3.3 | `a.espncdn.com/redesign/0.719.1/js/espn-defer.js`
espn.com.md:618:lodash.js | 4.15.0 | `a.espncdn.com/redesign/0.719.1/js/espn-critical.js`
espn.com.md:808:modernizr | 2.8.3 | `a.espncdn.com/redesign/0.719.1/js/espn-head.js`
espn.com.md:921:moment-timezone | 0.5.4 | `a.espncdn.com/redesign/0.719.1/js/espn-defer.js`
expedia.com.md:175:react |  | `expedia-api.arkoselabs.com/fc/assets/ec-game-core/game-core/1.27.4/standard/542.vendors.abe0e64e95582406fe38.js`
expedia.com.md:5:core-js | 3.33.3 | `expedia-api.arkoselabs.com/fc/assets/ec-game-core/game-core/1.27.4/standard/320.vendors.cca9b16e97778e82aac7.js`
expedia.com.md:7731:core-js | 3.38.1 | `expedia-api.arkoselabs.com/v2/2.11.5/enforcement.54d0c1f02c6eacbecf0b6c6c417771b0.js`
fandom.com.md:217:react | 18.3.1 | `www.fandom.com/f2/api/global-components/scripts/__cb6651876591644131/resources-ucp/mw139/dist/scripts/index-CrQhG4S2.js`
fandom.com.md:5:jquery | 3.7.1 | `www.fandom.com/f2/assets/common.en.js%3Fv%3Dce8b9ebeba0dedd3fd40cd098f517557c45ef360`
fandom.com.md:610:handlebars.js | 4.7.8 | `www.fandom.com/f2/assets/common.en.js%3Fv%3Dce8b9ebeba0dedd3fd40cd098f517557c45ef360`
fandom.com.md:697:lodash.js |  | `static.wikia.nocookie.net/silversurfer/prod/latest/pathfinder.js`
foxnews.com.md:219:lodash.js | 4.17.5 | `static.foxnews.com/static/strike/ver/foxnews/app/amp.v196.1.js`
foxnews.com.md:351:preact |  | `cdn.ketchjs.com/lanyard/v2/lanyard.js`
foxnews.com.md:470:react | 16.12.0 | `foxnewsplayer-a.akamaihd.net/player/9.0.23/akamai/amp/react/libs/react.min.js`
foxnews.com.md:5:jquery | 3.1.1 | `static.foxnews.com/static/orion/scripts/core/utils/ag.jquery.js`
github.com.md:155:three.js | r148 | `github.githubassets.com/assets/vendors-node_modules_three_build_three_module_js-e0c7a2724803.js`
github.com.md:5:react | 18.3.1 | `github.githubassets.com/assets/react-lib-f1bca44e0926.js`
healthline.com.md:1169:core-js | 3.39.0 | `ats-wrapper.privacymanager.io/ats-modules/89f1e4e8-db80-4402-9a08-9d36b4401007/ats.js`
healthline.com.md:1271:preact |  | `assets.healthline.com/_next/vendors~chunks/deferred-global-37269.js`
healthline.com.md:5:react | 16.14.0 | `assets.healthline.com/_next/vendors~chunks/driver-video~chunks/el~chunks/video~chunks/watch-next~chunks/yt-e8c79.js`
hilton.com.md:5:lodash.js | 4.17.5 | `assets.adobedtm.com/launch-EN02272261e0b845508227acf3ca0c37de.min.js`
hilton.com.md:656:react | 18.3.1 | `www.hilton.com/dx_cpm_app/_next/static/chunks/framework-4d893ceffa24a20c.js`
instagram.com.md:5157:react |  | `static.cdninstagram.com/rsrc.php/v4iQ4L4/y7/l/ko_KR/QJcHEPSGRuXMGpR6H6CypQhMXnKY2-ArlBe5pAaVYRZ7kuS-TaYKDyrTbmrxyAufe83FZx3zmpJok.js`
instagram.com.md:5:lodash.js |  | `static.cdninstagram.com/rsrc.php/v4/y2/r/IGyh6FUuJwY.js`
investopedia.com.md:108:core-js | 3.38.1 | `b-code.liadm.com/b-01g4.min.js`
investopedia.com.md:229:jquery | 3.6.0 | `www.investopedia.com/static/3.27.0/cache/eNqlU21ugzAMvdAiDrG_u4RJTPDqJF3ijNLTz9Cuo4WxaZOQ4q9nm2e7KQJCtgkQhbG5akxtaV71e6uYx6fmPkgdVYhJCItpK7GYgaQ330YHFcw7RGIGU2xOzI9RNoVjihilNBQFcwRuHHaYJ_wsZHRfoOQqY1miJJ8MdJ22BYJGwHvMV2uAc4or55.js`
investopedia.com.md:5:core-js | 3.37.0 | `launchpad.privacymanager.io/latest/launchpad.bundle.js`
irs.gov.md:172:jquery | 3.7.1 | `www.irs.gov/pub/js/js_owmADwSsc0CAsEkkpwzCOTwh9n4zF5pKbwUrQoH2OEI.js%3Fscope%3Dfooter%26delta%3D0%26language%3Den%26theme%3Dpup_irs%26include%3DeJxtkO12wyAIQF_IxEfyEKXKasQD2LVvv6Ttsq3rL72XjwNASsbQbh6en_kk3MwlMKhwQ_ELFrgQi7o-eoAYUZ`
irs.gov.md:321:jqueryui | 1.13.2 | `www.irs.gov/pub/js/js_owmADwSsc0CAsEkkpwzCOTwh9n4zF5pKbwUrQoH2OEI.js%3Fscope%3Dfooter%26delta%3D0%26language%3Den%26theme%3Dpup_irs%26include%3DeJxtkO12wyAIQF_IxEfyEKXKasQD2LVvv6Ttsq3rL72XjwNASsbQbh6en_kk3MwlMKhwQ_ELFrgQi7o-eoAYUZ`
irs.gov.md:5:jquery | 3.6.0 | `www.irs.gov/static_assets/js/libs/jquery.min.js`
irs.gov.md:622:underscore.js | 1.13.6 | `www.irs.gov/pub/js/js_owmADwSsc0CAsEkkpwzCOTwh9n4zF5pKbwUrQoH2OEI.js%3Fscope%3Dfooter%26delta%3D0%26language%3Den%26theme%3Dpup_irs%26include%3DeJxtkO12wyAIQF_IxEfyEKXKasQD2LVvv6Ttsq3rL72XjwNASsbQbh6en_kk3MwlMKhwQ_ELFrgQi7o-eoAYUZ`
linkedin.com.md:5:lodash |  | `static.licdn.com/aero-v1/sc/h/7jnp8ywr0nw8k0ri38x2g9kn0`
mapquest.com.md:4642:mapbox-gl |  | `www.mapquest.com/_next/static/chunks/05f6971a-6729def11d64a43c.js`
mapquest.com.md:5:react | 19.0.0 | `www.mapquest.com/_next/static/chunks/d648eb28-8346608b89a73108.js`
mayoclinic.org.md:158:moment.js | 2.30.1 | `www.mayoclinic.org/_next/static/chunks/pages/_app-c01b22871cc3a19f.js`
mayoclinic.org.md:417:bootstrap |  | `www.mayoclinic.org/_next/static/chunks/1508.5a5761fe6a1d59cd.js`
mayoclinic.org.md:5:react | 18.2.0 | `www.mayoclinic.org/_next/static/chunks/framework-75358cb82fbf83bf.js`
mcdonalds.com.md:100:jquery | 1.12.4 | `www.mcdonalds.com/etc.clientlibs/clientlibs/granite/jquery.lc-f9e8e8c279baf6a1a278042afe4f395a-lc.min.js`
mcdonalds.com.md:311:jqueryui | 1.12.1 | `www.mcdonalds.com/etc.clientlibs/mcdonalds/clientlibs/clientlib-site-global.lc-f487bf229b8c6f23d2e65604dec534ea-lc.min.js`
mcdonalds.com.md:493:lodash.js | 4.17.5 | `www.mcdonalds.com/etc.clientlibs/mcdonalds/clientlibs/clientlib-dependencies.lc-c063a5ce4739fa9a6c64b0045122369e-lc.min.js`
mcdonalds.com.md:5:jquery | 3.6.0 | `www.mcdonalds.com/etc.clientlibs/mcdonalds/clientlibs/clientlib-site-global.lc-f487bf229b8c6f23d2e65604dec534ea-lc.min.js`
mcdonalds.com.md:640:moment.js | 2.19.2 | `www.mcdonalds.com/etc.clientlibs/mcdonalds/clientlibs/clientlib-site-global.lc-f487bf229b8c6f23d2e65604dec534ea-lc.min.js`
medicalnewstoday.com.md:117:react |  | `assets.medicalnewstoday.com/_next/vendor-882d4.js`
medicalnewstoday.com.md:228:preact |  | `assets.medicalnewstoday.com/_next/vendors~chunks/deferred-global-0687c.js`
medicalnewstoday.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
medlineplus.gov.md:190:jqueryui |  | `www.nlm.nih.gov/core/nlm-autocomplete/1.0/nlm-autocomplete.js`
medlineplus.gov.md:5:jquery | 3.6.0 | `medlineplus.gov/jslib/jquery-3.6.0.min.js`
merriam-webster.com.md:1519:underscore |  | `www.merriam-webster.com/dist-cross-dungarees/2025-02-26--17-55-38-etzgd/compiled/js/js-home-redesign.fd362c6b57cb9df41cd0.js`
merriam-webster.com.md:1695:vue |  | `www.merriam-webster.com/dist-cross-dungarees/2025-02-26--17-55-38-etzgd/compiled/js/js-home-redesign.fd362c6b57cb9df41cd0.js`
merriam-webster.com.md:200:jQuery | 3.6.3 | `www.merriam-webster.com/dist-cross-dungarees/2025-02-26--17-55-38-etzgd/compiled/js/js-home-redesign.fd362c6b57cb9df41cd0.js`
merriam-webster.com.md:5:bootstrap | 5.1.3 | `www.merriam-webster.com/dist-cross-dungarees/2025-02-26--17-55-38-etzgd/compiled/js/js-home-redesign.fd362c6b57cb9df41cd0.js`
merriam-webster.com.md:644:core-js | 3.27.2 | `www.merriam-webster.com/dist-cross-dungarees/2025-02-26--17-55-38-etzgd/compiled/js/js-home-redesign.fd362c6b57cb9df41cd0.js`
merriam-webster.com.md:745:lodash.js |  | `ads.adthrive.com/builds/core/ecfdd67/vendor/prebid/es5/prebid.min.js`
merriam-webster.com.md:864:zepto |  | `www.merriam-webster.com/at-03-11-2024/at.js`
microsoft.com.md:126:jQuery | 3.5.1 | `www.microsoft.com/etc.clientlibs/cascade.component.authoring/clientlibs/clientlib-jquery.min.ACSHASH35986a813756f39ab6b922979ffedb03.js`
microsoft.com.md:310:preact |  | `mem.gfx.ms/scripts/me/MeControl/10.24228.4/ko-KR/meBoot.min.js`
microsoft.com.md:5:core-js | 3.27.2 | `www.microsoft.com/etc.clientlibs/microsoft/clientlibs/clientlib-mwf-new/main-light.min.ACSHASH13abf4cf4f8384d04a599349524dbbad.js`
mlb.com.md:1129:moment.js | 2.30.1 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/faf0dfaa-e20cc710e7b052d5.js`
mlb.com.md:113:core-js | 3.15.1 | `www.mlbstatic.com/mlb.com/vendor/mlb-okta/mlb-okta.js`
mlb.com.md:1235:react | 18.3.1 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/framework-5a3984d3ef1fd7fa.js`
mlb.com.md:1386:zepto | 2.3.0 | `www.mlbstatic.com/mlb.com/adobe-analytics/target/2.3.0/at.js`
mlb.com.md:1532:underscore.js | 1.13.1 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/26b4518c-5002cc87b922a2fe.js`
mlb.com.md:186:core-js | 3.39.0 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/de8ba445.a24fd5b1b4396322.js`
mlb.com.md:209:handlebars | 4.7.8 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/66dee5eb-e41027c19711223b.js`
mlb.com.md:309:jquery | 1.12.4 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/26b4518c-5002cc87b922a2fe.js`
mlb.com.md:490:jqueryui |  | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/26b4518c-5002cc87b922a2fe.js`
mlb.com.md:576:moment-timezone | 0.5.45 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/faf0dfaa-e20cc710e7b052d5.js`
mlb.com.md:5:backbone.js | 1.4.0 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/26b4518c-5002cc87b922a2fe.js`
mlb.com.md:694:lodash.js | 4.17.20 | `builds.mlbstatic.com/mlb.com/web-apps/x-homepage/_next/static/chunks/a6c7d93c.6275fc64ac5aafd3.js`
msn.com.md:352:lodash.js |  | `www.msn.com/bundles/v1/homePage/latest/web-worker.0d4ba93e360b42012611.js`
msn.com.md:396:preact |  | `mem.gfx.ms/scripts/me/MeControl/10.24228.4/ko-KR/meCore.min.js`
msn.com.md:498:react | 16.14.0 | `assets.msn.com/bundles/v1/homePage/latest/libs_finance-service-library_dist_redux_FinanceData_connector_js-node_modules_lodash-es_round_js.a42f766d853ab4dec117.js`
msn.com.md:5:knockout | 3.5.1 | `aadcdn.msftauth.net/shared/1.0/content/js/FetchSessions_Core_R0PmDES6QHGvk93sC6IvjQ2.js`
netflix.com.md:5:React | 18.2.0 | `assets.nflxext.com/web/ffe/wp/ui/signup/nmhp/nmhpFrameworkClient.b4ce8fb03b2f0189deaf.js`
netflix.com.md:710:lodash.js |  | `assets.nflxext.com/web/ffe/wp/ui/signup/nmhp/nmhpFrameworkClient.b4ce8fb03b2f0189deaf.js`
nfl.com.md:14221:require.js | 2.3.5 | `www.nfl.com/compiledassets/js/vendor/requirejs/require-2.3.5.min.js%3F_t%3Dbebd45d1f406bbe61424136b03e50895`
nfl.com.md:15365:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
nfl.com.md:15484:lodash.js |  | `cdns.us1.gigya.com/js/gigya.js%3Fapikey%3D3_Qa8TkWpIB8ESCBT8tY2TukbVKgO5F6BJVc7N1oComdwFzI7H2L9NOWdm11i_BY9f`
nfl.com.md:5598:react | 18.2.0 | `p.nfltags.com/react-dom/react-dom.production.min.js`
nfl.com.md:5:jquery | 3.6.0 | `www.nfl.com/compiledassets/js/e73b1ba6c3b8ae8823096fa5b989e838/vendor/jquery/jquery-3.6.0.min.js`
nih.gov.md:1176:jqueryui | 1.13.2 | `search.usa.gov/assets/sayt_loader_libs.js`
nih.gov.md:303:jquery | 2.2.4 | `code.jquery.com/jquery-2.2.4.min.js`
nih.gov.md:456:jquery.isotope |  | `www.nih.gov/sites/default/files/js/js_E9yUYWK8EMydR0HMIp2PahVxPAClXyH0Cnh782A15UM.js`
nih.gov.md:569:lodash.js | 4.17.21 | `ucm-us.verint-cdn.com/files/sites/nih-gov/live/sdk.js`
nih.gov.md:5:flexslider | 2.2.2 | `www.nih.gov/sites/default/files/js/js_JptcGXptsGRtUVJYOZbmqgxxhpYiOUb-ZoxREPRTjPM.js`
nih.gov.md:766:jquery | 3.5.1 | `search.usa.gov/assets/sayt_loader_libs.js`
nih.gov.md:964:swfobject | 2.1 | `www.nih.gov/sites/default/files/js/js_hNnF7a_sbk6nZ2-mOamHzalYND7HBHDLRInsaU93HDk.js`
nike.com.md:136:lodash | 4.17.21 | `www.nike.com/static/analytics-client/public/822.chunk.fbb8fb.js`
nike.com.md:237:react | 17.0.2 | `www.nike.com/assets/vendor/react/17.0.2/react.production.min.js`
nike.com.md:5:core-js |  | `www.nike.com/assets/experience/ciclp/landing-pages-next/static/v2/907-f7e96f18c0f/_next/static/chunks/881-619d0bbc09153c27.js`
nike.com.md:73:core-js | 3.27.2 | `web-sdk-cdn.singular.net/singular-sdk/latest/singular-sdk.js`
nps.gov.md:5:jquery | 1.12.4 | `www.nps.gov/ADF/thirdParty/jquery/jquery-1.12.js`
nytimes.com.md:197:lodash.js |  | `www.nytimes.com/vi-assets/static-assets/main-827c47e38c8f3ef58150.js`
nytimes.com.md:242:preact |  | `static01.nyt.com/video-static/vhs3/vhs.min.js`
nytimes.com.md:34:React | 18.2.0 | `www.nytimes.com/vi-assets/static-assets/home-73c67ccfc9048ca765b3.js`
nytimes.com.md:5:core-js | 3.18.0 | `static01.nyt.com/video-static/vhs3/vhs.min.js`
people.com.md:105:jquery | 3.6.0 | `people.com/static/3.7.0/cache/eNqdVG2S2yAMvVBVz56hf3sJGWSsjYAU5CTO6Qu2d9f5KJvpTGbQx3syEk_psqKy6Uz0xxgoaO7ObB2V00xZowcjbA6gCc2Bg3se_dFtZTwGFfrwhPvcvZffn4nSfA8qiUlZWJky9BOLwpl1hH-ifTHghIFFELJJUeQetWuDg1IKKJ2lgVLlL0Yi-0WKdhLKe5amC.js`
people.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
pinterest.com.md:314:core-js | 2.5.7 | `s.pinimg.com/webapp/37536-f036882a7fcaebae.mjs`
pinterest.com.md:579:lodash |  | `s.pinimg.com/webapp/49923-6d9698954b6adb6e.mjs`
pinterest.com.md:5:react |  | `s.pinimg.com/webapp/vendor-react-642d4b526e19e8c0.mjs`
quora.com.md:5:lodash |  | `qsbr.cf2.quoracdn.net/-4-ans_frontend-relay-vendor-27-ea2465b559af7eae.webpack`
quora.com.md:76:react | 18.2.0 | `qsbr.cf2.quoracdn.net/-4-ans_frontend-relay-vendor-27-ea2465b559af7eae.webpack`
rottentomatoes.com.md:193:jQuery | 3.7.1 | `www.rottentomatoes.com/assets/pizza-pie/javascripts/bundles/roma/vendors.a4cc402b78a.js`
rottentomatoes.com.md:500:lodash | 4.17.5 | `assets.adobedtm.com/launch-EN549327edc13e414a9beb5d61bfd9aac6.min.js`
rottentomatoes.com.md:5:core-js | 3.6.4 | `micro.rubiconproject.com/prebid/dynamic/24610.js`
rottentomatoes.com.md:961:zepto |  | `assets.adobedtm.com/launch-EN549327edc13e414a9beb5d61bfd9aac6.min.js`
si.com.md:254:jquery | 3.7.1 | `p329.si.com/plugin/library/7694d87d254044b8d06850550e7082d1`
si.com.md:5:core-js | 3.27.2 | `secure.cdn.fastclick.net/js/cnvr-coreid/latest/coreid.min.js`
si.com.md:6715:react | 16.13.1 | `assets.minutemediacdn.com/js/HomePageBogota.bundle.DOYIGOAB.js`
spotify.com.md:148:react | 18.3.1 | `open.spotifycdn.com/cdn/build/web-player/vendor~web-player.c766df23.js`
spotify.com.md:5:core-js | 3.40.0 | `open.spotifycdn.com/cdn/build/web-player/vendor~web-player.c766df23.js`
steampowered.com.md:218:jquery | 1.8.3 | `store.fastly.steamstatic.com/public/shared/javascript/jquery-1.8.3.min.js%3Fv%3DNXam5zydzNu8%26l%3Denglish%26_cdn%3Dfastly`
steampowered.com.md:375:react | 18.3.1 | `store.fastly.steamstatic.com/public/javascript/applications/store/libraries~b28b7af69.js%3Fv%3DvNpZeOuePA4R%26l%3Denglish%26_cdn%3Dfastly`
steampowered.com.md:5:google-closure-library |  | `store.fastly.steamstatic.com/public/javascript/applications/store/libraries~b28b7af69.js%3Fv%3DvNpZeOuePA4R%26l%3Denglish%26_cdn%3Dfastly`
target.com.md:1394:core-js | 3.40.0  | `assets.targetimg1.com/webui/top-of-funnel/_next/static/chunks/main-b06e91bfeef1e1c6.js`
target.com.md:1565:react | 18.3.1 | `assets.targetimg1.com/webui/top-of-funnel/_next/static/chunks/framework-c0839120a8cd1310.js`
target.com.md:5:lodash.js | 4.17.21 | `assets.targetimg1.com/webui/top-of-funnel/_next/static/chunks/vendor-6c09730736cbd610.js`
thesaurus.com.md:547:lodash.js |  | `player.anyclip.com/anyclip-widget/lre-widget/prod/v1/src/lre.js`
thesaurus.com.md:5:core-js | 3.38.1 | `b-code.liadm.com/a-04sx.min.js`
thesaurus.com.md:912:react | 18.2.0 | `www.thesaurus.com/vendor.6ca7aab4.js`
tiktok.com.md:397:lodash |  | `sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/tiktok/webapp/main/react-v17/webapp-desktop/webapp-desktop.121e47176512d93ed7b6.js`
tiktok.com.md:432:core-js |  | `sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/tiktok/webapp/main/react-v17/webapp-desktop/npm-async-cdf43e3d.cde92cd564a448ed8fa0.js`
tiktok.com.md:5:react | 17.0.2 | `sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/tiktok/webapp/main/react-v17/webapp-desktop/npm-react.84f0d5bba5f08e7f34cf.js`
timeanddate.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
usatoday.com.md:133:preact |  | `www.gannett-cdn.com/gps/applications/adapt/scripts/adapt-2-21-0.js`
usatoday.com.md:326:webfont |  | `www.gannett-cdn.com/gps/applications/adapt/scripts/adapt-2-21-0.js`
usatoday.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
usps.com.md:2961:jquery | 3.7.1 | `www.usps.com/global-elements/footer/script/jquery-3.7.1.js`
usps.com.md:5:bootstrap | 4.3.1 | `www.usps.com/assets/script/globals/bootstrap.js`
usps.com.md:8382:requirejs | 2.3.6 | `www.usps.com/global-elements/lib/script/requirejs/require-2.3.6.js`
walgreens.com.md:12009:jquery | 3.7.1 | `www.wag-static.com/common/react/assets/script.min.js%3Fo%3Dacs`
walgreens.com.md:12249:moment-timezone | 0.5.47 | `www.walgreens.com/sameday/react/assets/client_bundle_cos-1739763821005.js%3Fo%3Dacs`
walgreens.com.md:12752:moment.js | 2.30.1 | `www.walgreens.com/sameday/react/assets/client_bundle_cos-1739763821005.js%3Fo%3Dacs`
walgreens.com.md:16369:lodash.js | 4.17.5 | `www.walgreens.com/etc.clientlibs/core/wcm/components/commons/datalayer/v1/clientlibs/core.wcm.components.commons.datalayer.v1.min.904d3c2f1e821ab45124d66de422b409.js`
walgreens.com.md:18023:underscore.js | 1.8.3 | `www.wag-static.com/common/react/assets/client_bundle_header_lsg5-6f07ea1344728c49d3f8.js%3Fo%3Dacs`
walgreens.com.md:5:zepto |  | `assets.adobedtm.com/launch-ENdd5c82450e4a478ba693752c21000d75.min.js`
walgreens.com.md:9367:jqueryui | 1.12.1 | `www.wag-static.com/common/react/assets/script.min.js%3Fo%3Dacs`
walgreens.com.md:955:react | 18.2.0 | `www.walgreens.com/sameday/react/assets/client_bundle_odd-1739763821005.js%3Fo%3Dacs`
walmart.com.md:5:React | 18.2.0 | `i5.walmartimages.com/dfw/63fd9f59-6672/d9c4b32b-45cf-4f72-b27d-7d6dd0564d74/v2/en-US/_next/static/chunks/framework-fefcabe91382d59f.js`
weather.com.md:1183:lodash.js |  | `weather.com/daybreak-today/assets/main.da55762b2affde19000b.js`
weather.com.md:1285:zepto |  | `vidstat.taboola.com/vpaid/units/35_1_4/infra/cmTagINSTREAM.js`
weather.com.md:1382:react | 18.3.1 | `weather.com/daybreak-today/assets/main.da55762b2affde19000b.js`
weather.com.md:1706:underscore.js | 1.13.6 | `vidstat.taboola.com/vpaid/units/35_1_4/infra/cmTagINSTREAM.js`
weather.com.md:462:core-js | 3.34.0 | `s.w-x.co/helios/twc/1.40.5/helios.js`
weather.com.md:5:backbone.js | 1.5.0 | `vidstat.taboola.com/vpaid/units/35_1_4/infra/cmTagINSTREAM.js`
weather.com.md:752:d3 |  | `weather.com/daybreak-today/assets/1956.1956.381b20253270d8bf41f0.js`
weather.com.md:814:d3 | 5.9.1 | `weather.com/daybreak-today/assets/58857.58857.be3dec8d120fe95c69a4.js`
webmd.com.md:112:core-js | 3.31.0 | `hbx.media.net/bidexchange.js%3Fcid%3D8CURKHUZE%26version%3D12.1%26dn%3Dwww.webmd.com%26ysite%3Dwebmd%26ysection%3D1728`
webmd.com.md:140:lodash |  | `img.wbmdstatic.com/webmd_static_vue/091e9c5e823d0cb2/client/js/chunk-vendors.f698625f.js`
webmd.com.md:206:vue | 3.4.31 | `img.wbmdstatic.com/webmd_static_vue/091e9c5e823d0cb2/client/js/chunk-vendors.f698625f.js`
webmd.com.md:5:core-js | 3.6.4 | `secure.cdn.fastclick.net/js/pubcid/latest/pubcid.min.js`
www.nhs.uk.md:5:core-js |  | `assets.nhs.uk/scripts/cookie-consent.js`
www.nhs.uk.md:92:preact |  | `www.nhs.uk/static/nhsuk/js/main.f35b03b7573d.js`
yahoo.com.md:113:core-js | 3.37.0 | `s.yimg.com/uc/sf/0.1.434/js/safe.min.js`
yahoo.com.md:265:underscore | 1.13.6 | `vidstat.taboola.com/vpaid/units/35_1_4/infra/cmTagWIDGET_ITEM.js`
yahoo.com.md:394:zepto |  | `vidstat.taboola.com/vpaid/units/35_1_4/infra/cmTagWIDGET_ITEM.js`
yahoo.com.md:5:backbone | 1.5.0 | `vidstat.taboola.com/vpaid/units/35_1_4/infra/cmTagWIDGET_ITEM.js`
yelp.com.md:199:react |  | `s3-media0.fl.yelpcdn.com/assets/srv0/cdn_assets/eb9c642feb13/assets/vendor/react-dom/18.3.1/esm/react-dom.production.min.mjs`
yelp.com.md:222:d3 |  | `s3-media0.fl.yelpcdn.com/assets/public/module_yelp-frontend_shared-1d228fb4f00b1880e07a28035bac1d7ad34ba2ea.yji-950504fc1219bace82ed.mjs`
yelp.com.md:5:core-js | 2.6.11 | `s3-media0.fl.yelpcdn.com/assets/public/module_yelp-frontend_commons.yji-46b2fd0b47660c1a5b81.mjs`
yelp.com.md:95:lodash |  | `s3-media0.fl.yelpcdn.com/assets/public/module_yelp-frontend_commons.yji-46b2fd0b47660c1a5b81.mjs`
youtube.com.md:375:hammer.js | 2.0.2 | `www.youtube.com/s/_/ytmainappweb/_/js/k=ytmainappweb.kevlar_base.en_US.rDqcwSLLEa4.es5.O/d=0/br=1/rs%3DAGKMywEP764iD2Wn2o3V8FAhhQH1k1-slA`
youtube.com.md:432:spf | 2.4.0 | `www.youtube.com/s/desktop/50798525/jsbin/network.vflset/network.js`
youtube.com.md:5:d3 |  | `www.youtube.com/s/_/ytmainappweb/_/js/k=ytmainappweb.kevlar_base.en_US.rDqcwSLLEa4.es5.O/d=0/br=1/rs%3DAGKMywEP764iD2Wn2o3V8FAhhQH1k1-slA`
"""

def main():
    ground_truth = [parse_ground_truth(line) for line in INPUT.splitlines()]
    DATASET_PATH = os.path.join(os.getenv("HOME"), "path", "to", "data-never-remove")
    dataset = [
        {
            "urls": [domain, path],
            "groundTruth": [entry.package + (f"@{entry.version}" if entry.version is not None else "") for entry in entries],
            "source": open(os.path.join(DATASET_PATH, domain, path)).read(),
        } for (domain, path), entries in groupby(sorted(ground_truth, key=lambda x: (x.domain, x.path)), key=lambda x: (x.domain, x.path))
    ]

    with open(os.path.join(DATASET_PATH, "..", "dataset.json"), "w") as f:
        json.dump(dataset, f)

if __name__ == '__main__':
    main()
