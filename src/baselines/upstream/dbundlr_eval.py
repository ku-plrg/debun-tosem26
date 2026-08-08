import argparse
import hashlib
import json
import logging
import os.path
import socket
import subprocess
from enum import StrEnum, auto
from queue import Queue

import requests
import tree_sitter_javascript
from tree_sitter import Language, Parser, Node

HOSTNAME = socket.gethostname()
TS_JAVASCRIPT = Language(tree_sitter_javascript.language())
TRAINED_LIBS = None

FN_TYPES = ("function_declaration", "function_expression", "arrow_function")

def sha256(s: str):
    return hashlib.sha256(s.encode(), usedforsecurity=False).hexdigest()

def debug_node(source: bytes, node, logger):
    logger.debug("Found node: %s", node.type)
    while node is not None:
        logger.debug("Ancestor: %25s [%30s]: %s", node.type, node.start_point, source[node.byte_range[0]:node.byte_range[0] + 32])
        node = node.parent


def testf(source: bytes):
    logger = logging.getLogger("testf")
    parser = Parser(TS_JAVASCRIPT)
    ast = parser.parse(source)

    cursor = ast.root_node.walk()
    while True:
        if not cursor.goto_first_child():
            if not cursor.goto_next_sibling():
                while cursor.goto_parent():
                    if cursor.goto_next_sibling():
                        break
                if cursor.node.parent is None:
                    break
        if cursor.node.type == "string" and b"utils/lodash" in source[cursor.node.byte_range[0]:cursor.node.byte_range[1]]:
            debug_node(source, cursor.node, logger)
            break

    node = ast.root_node
    bfs_queue = Queue()
    level = 0
    fns_at_level = [0, 0]  # number of fns, number of non-fns
    while True:
        if node.is_named:
            # print(node.type)
            if node.type in FN_TYPES or node.type == "pair" and (
                # { 1: function(e, t, n) {
                node.child_by_field_name("value").type in FN_TYPES or
                # { 1: [function(e, t, n) {
                node.child_by_field_name("value").type == "array" and
                node.child_by_field_name("value").named_child_count >= 1 and
                node.child_by_field_name("value").named_child(0).type in FN_TYPES
            ) or (
                # , define("fly/libs/uuid.v4", function() {}), ...
                node.type == "call_expression" and
                any(arg.type in FN_TYPES for arg in node.child_by_field_name("arguments").named_children)
            ):
                fns_at_level[0] += 1
            else:
                fns_at_level[1] += 1

        # add all direct children to queue
        if node.named_child_count > 0:
            bfs_queue.put((node.named_children[0], level + 1))

        # Traverse to sibling or pop
        if node.next_named_sibling is not None:
            node = node.next_named_sibling
        elif bfs_queue.empty():
            break
        else:
            # check whether we found module array
            if fns_at_level[0] > 1:
                logger.debug(f"Found modules {level=}")
                module_object = node.parent
                if module_object.type == "sequence_expression" and module_object.parent is not None and module_object.parent.type == "expression_statement":
                    # Sequence expressions can have declaration siblings we do not want to miss
                    module_object = module_object.parent.parent
                logger.debug(f"Beginning: %s", source[module_object.byte_range[0]:module_object.byte_range[0]+256].decode())
                debug_node(source, module_object, logger)
                return module_object_to_names(module_object, source)
            elif node.parent is not None and node.parent.type == "statement_block":
                logger.debug(f"Discarding statement block because {fns_at_level=} {level=}")
                module_object = node.parent
                logger.debug(f"     Beginning: %s", source[module_object.byte_range[0]:module_object.byte_range[0]+32].decode())

            node, level = bfs_queue.get()
            fns_at_level[0], fns_at_level[1] = 0, 0
            continue

    # Fallback heuristic:
    # If bundle is tiny, search for functions in the top scope
    if len(source) < 1024:
        logger.warning("Using fallback heuristic for the following source code: \n%s", source)
        return module_object_to_function_strings(ast.root_node, source, logger)
    return None


def extract_modules(source: bytes):
    logger = logging.getLogger("extract_modules")
    parser = Parser(TS_JAVASCRIPT)
    ast = parser.parse(source)

    node = ast.root_node
    bfs_queue = Queue()
    level = 0
    fns_at_level = [0, 0]  # number of fns, number of non-fns
    while True:
        if node.is_named:
            # print(node.type)
            if node.type in FN_TYPES or node.type == "pair" and (
                # { 1: function(e, t, n) {
                node.child_by_field_name("value").type in FN_TYPES or
                # { 1: [function(e, t, n) {
                node.child_by_field_name("value").type == "array" and
                node.child_by_field_name("value").named_child_count >= 1 and
                node.child_by_field_name("value").named_child(0).type in FN_TYPES
            ) or (
                # , define("fly/libs/uuid.v4", function() {}), ...
                node.type == "call_expression" and
                any(arg.type in FN_TYPES for arg in node.child_by_field_name("arguments").named_children)
            ) or (
                # Adobe Launch (see debun dataset ID 77)
                node.type == "pair" and
                node.child_by_field_name("value").type == "object" and
                any(
                    # matches "modulePath" and "modules"
                    b"module" in source[pair.child_by_field_name("key").byte_range[0]:pair.child_by_field_name("key").byte_range[1]]
                    for pair in node.child_by_field_name("value").named_children
                )
            ):
                fns_at_level[0] += 1
            else:
                fns_at_level[1] += 1

        # add all direct children to queue
        if node.named_child_count > 0:
            bfs_queue.put((node.named_children[0], level + 1))

        # Traverse to sibling or pop
        if node.next_named_sibling is not None:
            node = node.next_named_sibling
        elif bfs_queue.empty():
                break
        else:
            # check whether we found module array
            if fns_at_level[0] > 1:
                logger.debug(f"Found modules {level=}")
                module_object = node.parent
                if module_object.type == "sequence_expression" and module_object.parent is not None and module_object.parent.type == "expression_statement":
                    # Sequence expressions can have declaration siblings we do not want to miss
                    module_object = module_object.parent.parent
                logger.debug(f"Beginning: %s", source[module_object.byte_range[0]:module_object.byte_range[0]+256].decode())
                return most_promising_module_object_to_function_strings(module_object, source, logger)
            elif node.parent is not None and node.parent.type == "statement_block":
                logger.debug(f"Discarding statement block because {fns_at_level=} {level=}")
                module_object = node.parent
                logger.debug(f"     Beginning: %s", source[module_object.byte_range[0]:module_object.byte_range[0]+32].decode())

            node, level = bfs_queue.get()
            fns_at_level[0], fns_at_level[1] = 0, 0
            continue

    # Fallback heuristic:
    # If bundle is tiny, search for functions in the top scope
    if len(source) < 1024:
        logger.warning("Using fallback heuristic for the following source code: \n%s", source)
        return module_object_to_function_strings(ast.root_node, source, logger)
    return None


class DetectionMethod(StrEnum):
    object_entry = auto()  # { 1234: function (e, n, t) {
    function_or_class_declaration = auto()  # function e(e, n) {
    variable_function_declaration = auto()  # var Ve = function (e, n) {, var Pe = () => ...
    variable_object_or_class_declaration = auto()  # var ee = { getArgName() { ...
    anonymous_call = auto()  # ! function() {} ()
    variable_anonymous_call = auto()  # var me = (function() {})()
    assignment = auto()  # Ve.v1 = function(e, n, t) {
    variable_single_object_argument_call = auto()  # var require_moo = __commonJS({
    function_argument_call = auto()  # $jscomp.polyfill("Map", function(NativeMap) {
    variable_function_argument_call = auto()  # var TextArea = forwardRef8((props, forwardRef9) =>


def most_promising_module_object_to_function_strings(module_object: Node, source: bytes, logger: logging.Logger = logging) -> list[tuple[str, str]]:
    candidates = []
    candidate = module_object
    while True:
        candidates.append(module_object_to_function_strings(candidate, source, logger))
        if candidate.parent is None:
            break
        candidate = candidate.parent
    logger.info(f"Found %s candidates", len(candidates))

    return max(candidates, key=lambda c: sum(len(f) for f, _ in c) * (1 + (len(c) / 100)))


def module_object_to_function_strings(module_object: Node, source: bytes, logger: logging.Logger = logging) -> list[tuple[str, str]]:
    """
    Extracts modules from an module object

    :param module_object: Tree Sitter AST node of the module object
    :param source: source byte string
    :param logger: logger to use
    :return: list with an entry (source, type of module detection)
    """
    byte_ranges = []
    potential_modules = Queue()
    for node in module_object.named_children:
        potential_modules.put(node)

    # In special cases we want to consider siblings or higher level nodes as well
    if module_object.parent is not None:
        if module_object.parent.type in FN_TYPES and \
            module_object.parent.parent is not None and \
            module_object.parent.parent.type == "call_expression":
            # Our module_object parameter is part of a function body of an IIFE
            # Consider the arguments as well
            for argument in module_object.parent.parent.child_by_field_name("arguments").named_children:
                for node in argument.named_children:
                    potential_modules.put(node)

    while not potential_modules.empty():
        node = potential_modules.get()

        byte_ranges_len = len(byte_ranges)
        # Traversal Rules
        if node.type == "expression_statement":
            # ! function() {} ()
            node = node.named_child(0)
        if node.type == "parenthesized_expression":
            node = node.named_child(0)
        if node.type == "sequence_expression":
            for child in node.named_children:
                potential_modules.put(child)
            continue
        if node.type == "if_statement":
            # Hoisted if's have been observed multiple times
            for child in node.child_by_field_name("consequence").named_children:
                potential_modules.put(child)
            if node.child_by_field_name("alternative") is not None:
                for child in node.child_by_field_name("alternative").named_children:
                    potential_modules.put(child)
            continue
        if node.type == "assignment_expression":
            # Ve.v1 = function(e, n, t) {
            potential_modules.put(node.child_by_field_name("right"))
            continue
        if node.type == "unary_expression":
            # ! function() {} ()
            potential_modules.put(node.child_by_field_name("argument"))
            continue
        if node.type == "object":
            # If any of the values is a literal or object, we don't have a classical Webpack module object, so recurse into
            if any(pair.type == "pair" and pair.child_by_field_name("value").type in ("string", "object") for pair in node.named_children):
                for pair in node.named_children:
                    if pair.type == "pair":
                        potential_modules.put(pair.child_by_field_name("value"))
                continue
            if node.named_child_count == 1 and node.named_child(0).type == "pair" and node.named_child(0).child_by_field_name("value").type in FN_TYPES:
                # In Adobe launch, the modules look like { source: function() {
                potential_modules.put(node.named_child(0).child_by_field_name("value"))
                continue
        if node.type == "call_expression":
            # define("browsePostings",["./public-es5-libs","./lib"], (function(t,e){
            if node.child_by_field_name("function").type == "identifier":
                for argument in node.child_by_field_name("arguments").named_children:
                    potential_modules.put(argument)
                continue


        # Extraction Rules
        if node.type in FN_TYPES + ("class_declaration",):
            byte_ranges.append((node.byte_range, DetectionMethod.function_or_class_declaration))
        elif node.type == "call_expression":
            callee = node.child_by_field_name("function")
            arguments = node.child_by_field_name("arguments")
            if callee is not None and callee.type in FN_TYPES + ("parenthesized_expression",):
                byte_ranges.append((callee.byte_range, DetectionMethod.anonymous_call))
            if arguments is not None and any(arg.type in FN_TYPES for arg in arguments.named_children):
                func = next(arg for arg in arguments.named_children if arg.type in FN_TYPES)
                byte_ranges.append((func.byte_range, DetectionMethod.function_argument_call))
        elif node.type in ("variable_declaration", "lexical_declaration"):
            for declarator in node.named_children:
                declarator_value = declarator.child_by_field_name("value")
                if declarator_value is not None and declarator_value.type == "parenthesized_expression":
                    # var ResizeObserverController = (
                    #   /** @class */
                    #   function() {
                    declarator_value = declarator_value.named_child(0)
                    while declarator_value.type == "comment":
                        if declarator_value.next_named_sibling is None:
                            break
                        else:
                            declarator_value = declarator_value.next_named_sibling
                if declarator_value is not None and declarator_value.type in FN_TYPES:
                    byte_ranges.append((declarator_value.byte_range, DetectionMethod.variable_function_declaration))
                if declarator_value is not None and declarator_value.type in ("object", "class"):
                    byte_ranges.append((declarator_value.byte_range, DetectionMethod.variable_object_or_class_declaration))
                if declarator_value is not None and declarator_value.type == "call_expression":
                    callee = declarator_value.child_by_field_name("function")
                    arguments = declarator_value.child_by_field_name("arguments")
                    if callee is not None and callee.type in FN_TYPES + ("parenthesized_expression",):
                        byte_ranges.append((callee.byte_range, DetectionMethod.variable_anonymous_call))
                    elif arguments is not None and arguments.named_child_count == 1 and arguments.named_child(0).type == "object":
                        byte_ranges.append((arguments.named_child(0).byte_range, DetectionMethod.variable_single_object_argument_call))
                    elif arguments is not None and any(arg.type in FN_TYPES for arg in arguments.named_children):
                        func = next(arg for arg in arguments.named_children if arg.type in FN_TYPES)
                        byte_ranges.append((func.byte_range, DetectionMethod.variable_function_argument_call))
        elif node.type == "pair":
            value = node.child_by_field_name("value")
            byte_ranges.append((value.byte_range, DetectionMethod.object_entry))

        if byte_ranges_len == len(byte_ranges):
            node_len = node.byte_range[1] - node.byte_range[0]
            if node_len > 1000 and node.type != "comment":
                logger.warning("Skipping %s bytes. Beginning: %s", node_len, source[node.byte_range[0]:node.byte_range[0] + 128])

    # skip functions with less than N chars
    return [
        (source[byte_range[0]:byte_range[1]].decode(), method)
        for byte_range, method in byte_ranges
        # if byte_range[1] - byte_range[0] < min_fn_length
    ]


def module_object_to_names(module_object: Node, source: bytes) -> list[str]:
    names = []
    potential_modules = Queue()
    for node in module_object.named_children:
        potential_modules.put(node)

    # In special cases we want to consider siblings or higher level nodes as well
    if module_object.parent is not None:
        if module_object.parent.type in FN_TYPES and \
            module_object.parent.parent is not None and \
            module_object.parent.parent.type == "call_expression":
            # Our module_object parameter is part of a function body of an IIFE
            # Consider the arguments as well
            for argument in module_object.parent.parent.child_by_field_name("arguments").named_children:
                for node in argument.named_children:
                    potential_modules.put(node)

    while not potential_modules.empty():
        byte_ranges = []
        pop_last_name = False

        node = potential_modules.get()

        if node.type == "expression_statement":
            node = node.named_child(0)
        if node.type == "sequence_expression":
            for child in node.named_children:
                potential_modules.put(child)
            continue
        if node.type == "if_statement":
            # Hoisted if's have been observed multiple times
            for child in node.child_by_field_name("consequence").named_children:
                potential_modules.put(child)
            if node.child_by_field_name("alternative") is not None:
                for child in node.child_by_field_name("alternative").named_children:
                    potential_modules.put(child)
            continue
        if node.type == "unary_expression":
            node = node.child_by_field_name("argument")
        if node.type == "assignment_expression":
            lvalue = node.child_by_field_name("left")
            names.append((source[lvalue.byte_range[0]:lvalue.byte_range[1]].decode(), DetectionMethod.assignment))
            # If we don't find the correct expression on the right side, we will pop this name again
            # Else we will pop the anonymous name that gets pushed
            pop_last_name = True
            node = node.child_by_field_name("right")
        if node.type in ("function_declaration", "class_declaration"):
            byte_ranges.append((node.child_by_field_name("name").byte_range, DetectionMethod.function_or_class_declaration))
        elif node.type in FN_TYPES:
            # function_declaration is handled above, so node is definitely anonymous here
            names.append(
                (f"<lambda '{source[node.byte_range[0]:node.byte_range[0]+32].decode().replace('\n', '')}'>",
                 DetectionMethod.function_or_class_declaration)
            )
        elif node.type == "call_expression":
            callee = node.child_by_field_name("function")
            arguments = node.child_by_field_name("arguments")
            if callee is not None and callee.type in FN_TYPES + ("parenthesized_expression",):
                names.append(
                    (f"<lambda '{source[callee.byte_range[0]:callee.byte_range[0]+32].decode().replace('\n', '')}'>",
                     DetectionMethod.anonymous_call)
                )
            if arguments is not None and any(arg.type in FN_TYPES for arg in arguments.named_children):
                func = next(arg for arg in arguments.named_children if arg.type in FN_TYPES)
                names.append(
                    (f"<lambda '{source[func.byte_range[0]:func.byte_range[0]+32].decode().replace('\n', '')}'>",
                     DetectionMethod.function_argument_call)
                )
        elif node.type in ("variable_declaration", "lexical_declaration"):
            # Iterate all declarators
            for declarator in node.named_children:
                declarator_value = declarator.child_by_field_name("value")
                if declarator_value is not None and declarator_value.type == "parenthesized_expression":
                    declarator_value = declarator_value.named_child(0)
                    while declarator_value.type == "comment":
                        if declarator_value.next_named_sibling is None:
                            break
                        else:
                            declarator_value = declarator_value.next_named_sibling
                if declarator_value is not None and declarator_value.type in FN_TYPES:
                    byte_ranges.append((declarator.child_by_field_name("name").byte_range, DetectionMethod.variable_function_declaration))
                if declarator_value is not None and declarator_value.type in ("object", "class"):
                    byte_ranges.append((declarator.child_by_field_name("name").byte_range, DetectionMethod.variable_object_or_class_declaration))
                if declarator_value is not None and declarator_value.type == "call_expression":
                    callee = declarator_value.child_by_field_name("function")
                    arguments = declarator_value.child_by_field_name("arguments")
                    if callee is not None and callee.type in FN_TYPES + ("parenthesized_expression",):
                        byte_ranges.append((declarator.child_by_field_name("name").byte_range, DetectionMethod.variable_anonymous_call))
                    elif arguments is not None and arguments.named_child_count == 1 and arguments.named_child(0).type == "object":
                        byte_ranges.append((declarator.child_by_field_name("name").byte_range, DetectionMethod.variable_single_object_argument_call))
                    elif arguments is not None and any(arg.type in FN_TYPES for arg in arguments.named_children):
                        byte_ranges.append((declarator.child_by_field_name("name").byte_range, DetectionMethod.variable_function_argument_call))
        if pop_last_name:
            names.pop()
        for byte_range, method in byte_ranges:
            names.append((source[byte_range[0]:byte_range[1]].decode(), method))

    return names


def dbundlr_detects_webpack(bundle: str, dbundlr_repo: str) -> bool:
    detection = subprocess.run(
        ["bun", "run", os.path.join(dbundlr_repo, "src", "unbundle", "checkcompiledbywebpack.ts")],
        input=bundle,
        stdout=subprocess.PIPE,
        encoding="utf8"
    )
    detection.check_returncode()
    return b"not compiled" not in detection.stdout



def main():
    global TRAINED_LIBS

    logger = logging.getLogger("main")
    parser = argparse.ArgumentParser(description='Evaluate D-Bundlr')
    parser.add_argument("--dbundlr-repo", type=str, required=True, help="Path to D-Bundlr repo root")
    parser.add_argument("-o", "--output", type=str, required=True, help="Output filename")
    parser.add_argument("--id", type=int, help="Debug ID")
    args = parser.parse_args()

    logger.info("Running in mode %s on %s", args.mode, HOSTNAME)

    DBUNDLR_URL = "http://localhost:3446/predict"
    DATASET_PATH = os.path.join("path", "to", "dataset.json")
    TRAINED_LIBS = [f.split(".", 1)[0].replace("+", "/") for f in os.listdir("path", "to", "dbundlr-debun-dataset")]

    with open(DATASET_PATH, "r") as f:
        data = json.load(f)

    if HOSTNAME == "ruidoso":
        idx = args.id
        with open("/tmp/bundle.min.js", "w") as f:
            f.write(data[idx]["source"])
        # with open("/tmp/bundle.js.map", "w") as f:
        #     f.write(data[idx]["sourcemap"])
        # print(testf(data[idx]["source"].encode()))
        source = data[idx]["source"].encode()
        # source = open("/tmp/bundle.js", "rb").read()
        output = testf(source)
        for name, method in output:
            print(f"{name:>32}      {str(method)}")
        functions = extract_modules(source)
        print(f"ground truth", data[idx]["groundTruth"])
        print(f"covered: {sum(len(f) for f, _ in functions)}/{len(source)} with {len(functions)} modules")
        exit(0)

    result = []
    logger.info("Starting. Total bundles: %s", len(data))

    for i, bundle_data in enumerate(data):
        # Step 1: Extract functions
        functions = extract_modules(bundle_data["source"].encode())

        # Plausibility
        if functions is None or len(functions) == 0:
            logger.warning("No modules found in bundle. ID: %s", i)
            result.append({"error": "no modules found in bundle"})
            continue
        elif max(len(f) for f, _ in functions) > len(bundle_data["source"]):
            logger.warning("Extracted a function that takes more than 80%% of the bundle. ID: %s", i)
        elif sum(len(f) for f, _ in functions) < len(bundle_data["source"]) * 0.8 - 200:  # 200 is runtime overhead
            logger.warning("Extracted functions that comprise less than 80%% (%s/%s) of the bundle. ID: %s",  sum(len(f) for f, _ in functions), len(bundle_data["source"]), i)
        logger.info("Covering %.0f%% of the text size of the bundle with %s modules", 100 * sum(len(f) for f, _ in functions) / len(bundle_data["source"]), len(functions))

        # Step 2: Send to dbundlr
        detections = []
        for fun, method in functions:
            resp = requests.post(DBUNDLR_URL, json={"code": fun})
            detections.append({
                "moduleStrlength": len(fun),
                "moduleDetectionMethod": str(method),
                "dbundlr": resp.json()
            })

        # Step 3: Store with response
        result.append({
            "urls": bundle_data["urls"],
            "bundle": sha256(bundle_data["source"]),
            "groundTruth": bundle_data["groundTruth"],
            "numberOfModules": len(functions),
            "coverage": 100 * sum(len(f) for f, _ in functions) / len(bundle_data["source"]),
            "detections": detections,
        })

        logger.info(f"Progress: {i+1}/{len(data)}")

    with open(args.output, "w") as f:
        json.dump({"result": result, "trained_libs": TRAINED_LIBS}, f)

if __name__ == '__main__':
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    logging.getLogger("main").setLevel(logging.DEBUG)
    logging.getLogger("main").addHandler(handler)
    logging.getLogger("testf").setLevel(logging.DEBUG)
    logging.getLogger("testf").addHandler(handler)
    logging.getLogger("extract_modules").setLevel(logging.WARNING)
    logging.getLogger("extract_modules").addHandler(handler)
    main()
