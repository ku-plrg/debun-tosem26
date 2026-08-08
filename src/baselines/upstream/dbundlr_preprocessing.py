import argparse
import os
import shutil
import subprocess
import tempfile

webpack_config_tmpl = r"""
var webpack = require("webpack");

module.exports = {
    mode: "production",
    devtool: "source-map",
    optimization: {
        usedExports: false,
        providedExports: false,
        sideEffects: false,
        minimize: true,
        splitChunks: false,
        runtimeChunk: false,
    },
    entry: "./main.js",
    output: {
        filename: "main.js"
    },
    module: {
        rules: [
            { 
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader'
            },
            {
                test: /\.css$/,
                exclude: /node_modules/,
                use: 'css-loader'
            },
            {
                test: /\.(ico|jpg|png|gif|eot|otf|webp|svg|ttf|woff|woff2)(\?.*)?$/,
                loader: 'file-loader',
                options: {
                  name: 'static/media/[name].[hash:8].[ext]'
                }
            }
        ]
    },
    plugins: [
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1,
        })
    ]
};
"""

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-o", "--output-dir", type=str, required=True)
    parser.add_argument(
        "packages",
        nargs="+",
        type=str,
        help="Packages to preprocess",
    )
    args = parser.parse_args()

    STORE_PATH = "/tmp/.pnpm-store/v3"
    PATH_TO_DBUNDLR_REPO = "/path/to/D-Bundlr"

    with tempfile.TemporaryDirectory(dir="/tmp") as tmp_dir:
        orig_dir = os.getcwd()
        os.chdir(tmp_dir)

        subprocess.run(
            [
                "pnpm",
                "config",
                "set",
                "store-dir",
                STORE_PATH,
            ],
            cwd=tmp_dir,
        )

        for n, package in enumerate(args.packages):
            output_file = os.path.join(args.output_dir, f"{package.replace('/', '+')}.jsonl")
            if os.path.isfile(output_file):
                print(f"Skipping {package}: output file already existing")
                continue

            if n % 100 == 50:
                # Regular cleanup
                shutil.rmtree(STORE_PATH, ignore_errors=True)

            if os.path.isdir(os.path.join(tmp_dir, "node_modules")):
                shutil.rmtree(os.path.join(tmp_dir, "node_modules"), ignore_errors=True)
            os.makedirs(os.path.join(tmp_dir, "node_modules"), exist_ok=True)

            with open(os.path.join(tmp_dir, "webpack.config.js"), "w") as f:
                f.write(webpack_config_tmpl)

            entrypoint = f"""
                const pkg = require("{package}")

                for (const prop in pkg) console.log(prop);
            """

            with open(os.path.join(tmp_dir, "main.js"), "w") as f:
                f.write(entrypoint)

            try:
                subprocess.run(
                    [
                        "pnpm",
                        "install",
                        "-D",
                        "webpack",
                        "webpack-cli",
                    ],
                    cwd=tmp_dir,
                )
                subprocess.run(
                    [
                        "pnpm",
                        "install",
                        "--save-exact",
                        "--no-optional",
                        "--ignore-scripts",
                        "--config.confirmModulesPurge=false",
                        package
                    ],
                    cwd=tmp_dir,
                    stdin=subprocess.DEVNULL,
                    timeout=60
                )

                subprocess.run(
                    [
                        "npx",
                        "webpack-cli",
                    ],
                    cwd=tmp_dir,
                    timeout=180
                )

                compiled_file = os.path.join(tmp_dir, "dist", "main.js")
                original_root = tmp_dir
                build_dir = os.path.join(tmp_dir, "dist")
                dbundlr_script = f"""
                    const {'{'} extractSingle {'}'} = require("./lib/unbundle/extract");
                    
                    extractSingle("{compiled_file}", "{original_root}", "{build_dir}", "{package}");
                """.encode()

                subprocess.run(
                    [
                        "node"
                    ],
                    cwd=os.path.join(PATH_TO_DBUNDLR_REPO, "d-bundlr"),
                    input=dbundlr_script,
                    timeout=300,
                )

                preprocessed_file = os.path.join(tmp_dir, "dist", "main.js.jsonl")
                if os.path.isfile(preprocessed_file):
                    shutil.copy(preprocessed_file, output_file)
                else:
                    print(f"WARNING: Could not find {preprocessed_file} ({package=})")

                subprocess.run(
                    [
                        "pnpm",
                        "uninstall",
                        package,
                    ],
                    cwd=tmp_dir,
                    timeout=60
                )
            except subprocess.TimeoutExpired:
                # Cannot install automatically, so create empty placeholder file
                with open(os.path.join(args.output_dir, f"{package.replace('/', '+')}.js"), "w") as f:
                    pass
            finally:
                if os.path.exists(os.path.join(tmp_dir, "dist")):
                    shutil.rmtree(os.path.join(tmp_dir, "dist"), ignore_errors=True)

            n += 1

        os.chdir(orig_dir)
