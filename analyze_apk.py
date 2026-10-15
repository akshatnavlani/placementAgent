import os
import re
import argparse
import json
import shutil
import struct
import zipfile
from urllib.parse import urlparse

HERMES_MAGIC = 0x1F1903C103BC1FC6

NOISE_HOST_SUFFIXES = (
    "android.com",
    "apache.org",
    "callstack.github.io",
    "facebook.com",
    "fb.me",
    "github.com",
    "googleapis.com",
    "google.com",
    "gstatic.com",
    "localhost",
    "momentjs.com",
    "react.dev",
    "reactnavigation.org",
    "rnfirebase.io",
    "schema.org",
    "swmansion.com",
    "w3.org",
    "xmlpull.org",
)

MIME_PREFIXES = (
    "application/",
    "audio/",
    "font/",
    "image/",
    "model/",
    "multipart/",
    "text/",
    "video/",
)


def read_uleb128(data, offset):
    result = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, offset
        shift += 7
        if shift > 35:
            break
    return None, offset


def iter_dex_strings(data):
    if len(data) < 112 or data[:4] != b"dex\n":
        return
    string_ids_size = struct.unpack_from("<I", data, 56)[0]
    string_ids_off = struct.unpack_from("<I", data, 60)[0]
    end = string_ids_off + string_ids_size * 4
    if end > len(data):
        return
    for index in range(string_ids_size):
        string_off = struct.unpack_from("<I", data, string_ids_off + index * 4)[0]
        if string_off >= len(data):
            continue
        length, cursor = read_uleb128(data, string_off)
        if length is None or cursor + length > len(data):
            continue
        raw = data[cursor:cursor + length]
        try:
            yield raw.decode("utf-8")
        except UnicodeDecodeError:
            continue


def parse_hermes_header(data):
    if len(data) < 64:
        return None
    magic, version = struct.unpack_from("<QI", data, 0)
    if magic != HERMES_MAGIC and (magic & 0xFFFFFFFFFFFF) != 0x1F1903C103BC:
        return None
    file_length = struct.unpack_from("<I", data, 32)[0]
    if file_length != len(data):
        return None
    return {
        "version": version,
        "function_count": struct.unpack_from("<I", data, 40)[0],
        "string_kind_count": struct.unpack_from("<I", data, 44)[0],
        "identifier_count": struct.unpack_from("<I", data, 48)[0],
        "string_count": struct.unpack_from("<I", data, 52)[0],
        "overflow_count": struct.unpack_from("<I", data, 56)[0],
        "storage_size": struct.unpack_from("<I", data, 60)[0],
    }


def decode_hermes_strings(data, header, header_size, function_header_size, kind_size):
    function_count = header["function_count"]
    kind_count = header["string_kind_count"]
    identifier_count = header["identifier_count"]
    string_count = header["string_count"]
    overflow_count = header["overflow_count"]
    storage_size = header["storage_size"]

    table_off = (
        header_size
        + function_count * function_header_size
        + kind_count * kind_size
        + identifier_count * 4
    )
    if table_off % 4:
        table_off += 4 - (table_off % 4)
    overflow_off = table_off + string_count * 4
    storage_off = overflow_off + overflow_count * 8
    storage_end = storage_off + storage_size
    if storage_end > len(data) or table_off < 0:
        return None

    storage = data[storage_off:storage_end]
    strings = []
    overflow_index = 0
    readable = 0
    for index in range(string_count):
        entry = struct.unpack_from("<I", data, table_off + index * 4)[0]
        is_utf16 = entry & 1
        offset = (entry >> 1) & 0x7FFFFF
        length = (entry >> 24) & 0xFF
        if length == 0xFF:
            if overflow_index >= overflow_count:
                return None
            offset, length = struct.unpack_from("<II", data, overflow_off + overflow_index * 8)
            overflow_index += 1
        if offset + length > storage_size:
            return None
        raw = storage[offset:offset + length]
        try:
            text = raw.decode("utf-16-le" if is_utf16 else "utf-8")
        except UnicodeDecodeError:
            text = ""
        strings.append(text)
        if text and text.isprintable():
            readable += 1
    if overflow_index != overflow_count:
        return None
    if not strings or readable / len(strings) < 0.8:
        return None
    return strings


def hermes_strings(data):
    header = parse_hermes_header(data)
    if not header:
        return []
    best = None
    best_score = -1
    for header_size in (128, 120, 112):
        for function_header_size in (16, 20, 24, 32):
            for kind_size in (4, 8):
                strings = decode_hermes_strings(
                    data, header, header_size, function_header_size, kind_size
                )
                if not strings:
                    continue
                sample = strings[:200]
                score = sum(
                    1
                    for item in sample
                    if re.match(r"^[A-Za-z_$][\w$.]{0,60}$", item)
                )
                if score > best_score:
                    best_score = score
                    best = strings
    if best_score < 20:
        return []
    return best or []


def text_strings(data):
    text = data.decode("utf-8", "ignore")
    return re.findall(r"[\x20-\x7e]{4,200}", text)


def looks_like_endpoint(value):
    if not value or len(value) < 3 or len(value) > 160:
        return False
    if any(char.isspace() for char in value) or value.count("/") < 1:
        return False
    if value.startswith(".") or "/./" in value or value.lower() in {"n/a", "/n/a"}:
        return False
    if not re.fullmatch(r"[A-Za-z0-9_./?=&%-]+", value):
        return False
    lowered = value.lower().lstrip("/")
    if lowered.startswith((
        "assets/",
        "caches/",
        "node_modules/",
        "proc/",
        "system/",
        "data/",
    )):
        return False
    if any(lowered.startswith(prefix) for prefix in MIME_PREFIXES):
        return False
    if lowered.endswith((
        ".js", ".png", ".jpg", ".jpeg", ".ttf", ".xml", ".html", ".webp", ".gif",
    )):
        return False
    if not re.search(r"[A-Za-z]", value):
        return False
    if re.fullmatch(r"[dmy/\-.]+", lowered):
        return False
    return True


def clean_url(value):
    match = re.match(r"https?://[^\s\"'<>\\]+", value)
    if not match:
        return None
    url = match.group(0).rstrip(".,);")
    if "%s" in url or "%d" in url:
        return None
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host or host in ("localhost", "127.0.0.1"):
        return None
    return url


def is_app_url(url):
    host = (urlparse(url).hostname or "").lower()
    return not any(host == suffix or host.endswith("." + suffix) for suffix in NOISE_HOST_SUFFIXES)


def collect_from_apk(apk_path):
    app_urls = set()
    library_urls = set()
    endpoints = set()

    with zipfile.ZipFile(apk_path) as archive:
        for info in archive.infolist():
            name = info.filename
            if info.file_size == 0 or info.file_size > 40_000_000:
                continue
            lower_name = name.lower()
            if lower_name.endswith(".dex"):
                for item in iter_dex_strings(archive.read(name)):
                    url = clean_url(item)
                    if not url:
                        continue
                    if is_app_url(url):
                        app_urls.add(url)
                    else:
                        library_urls.add(url)
                continue

            if not (
                lower_name.endswith(".bundle")
                or lower_name.endswith(".js")
                or lower_name.endswith(".hbc")
            ):
                continue
            payload = archive.read(name)
            strings = hermes_strings(payload)
            if not strings:
                strings = text_strings(payload)
            for item in strings:
                url = clean_url(item)
                if url:
                    if is_app_url(url):
                        app_urls.add(url)
                    else:
                        library_urls.add(url)
                elif looks_like_endpoint(item):
                    endpoints.add(item if item.startswith("/") else "/" + item)

    return sorted(app_urls), sorted(endpoints), sorted(library_urls)


def find_apktool_jar():
    bat = shutil.which("apktool") or shutil.which("apktool.bat")
    candidates = []
    if bat:
        directory = os.path.dirname(os.path.abspath(bat))
        candidates.append(os.path.join(directory, "apktool.jar"))
    candidates.append(r"C:\Windows\apktool.jar")
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def decompile_apk(apk_path, output_dir):
    """Decode with java -jar. Python cannot execute apktool.bat, and that
    wrapper also pauses when launched through cmd /c."""
    import subprocess

    jar = find_apktool_jar()
    if not jar:
        raise FileNotFoundError("apktool.jar was not found next to apktool.bat")
    java = shutil.which("java") or "java"
    completed = subprocess.run(
        [java, "-jar", jar, "d", "-f", "-o", output_dir, apk_path],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(detail or f"apktool exited with status {completed.returncode}")
    return output_dir


def process_smali_files(folder_path):
    http_annotations = []
    okhttp3_variables = []
    annotation_pattern = re.compile(
        r"\.annotation runtime Lretrofit2/http/([A-Z]+);([\s\S]*?)\.end annotation"
    )
    okhttp3_pattern = re.compile(r"\.field .*? Lokhttp3/")

    for root, _, files in os.walk(folder_path):
        for file in files:
            if not file.endswith(".smali"):
                continue
            file_path = os.path.join(root, file)
            with open(file_path, "r", encoding="utf-8", errors="replace") as smali_file:
                content = smali_file.read()
            http_annotations.extend(annotation_pattern.findall(content))
            okhttp3_variables.extend(okhttp3_pattern.findall(content))
    return http_annotations, okhttp3_variables


def generate_txt_output(app_urls, endpoints, library_urls, http_annotations, okhttp3_variables, output_file):
    lines = []
    lines.append("App base URLs:")
    lines.extend(app_urls or ["(none)"])
    lines.append("")
    lines.append("App endpoints:")
    lines.extend(endpoints or ["(none)"])
    lines.append("")
    lines.append("Library URLs:")
    lines.extend(library_urls or ["(none)"])

    if http_annotations:
        lines.append("")
        lines.append("Retrofit annotations:")
        for annotation in http_annotations:
            lines.append(f"HTTP Method: {annotation[0].strip()}")
            lines.append(f"Value: {annotation[1].strip()}")
            lines.append("")

    if okhttp3_variables:
        lines.append("")
        lines.append("OkHttp3 fields:")
        for variable in okhttp3_variables:
            lines.append(variable.strip())

    with open(output_file, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines).rstrip() + "\n")
    print(f"Output file created: {output_file}")
    print(f"App URLs: {len(app_urls)}")
    print(f"App endpoints: {len(endpoints)}")
    print(f"Library URLs: {len(library_urls)}")
    print(f"Retrofit annotations: {len(http_annotations)}")


def generate_postman_output(app_urls, endpoints, http_annotations, output_file):
    base_url = app_urls[0] if app_urls else "{{base_url}}"
    if not base_url.endswith("/"):
        base_url += "/"
    items = []
    for endpoint in endpoints:
        path = endpoint[1:] if endpoint.startswith("/") else endpoint
        items.append({
            "name": path,
            "request": {
                "method": "GET",
                "url": base_url + path,
            },
        })
    for annotation in http_annotations:
        method = annotation[0].strip()
        value = " ".join(annotation[1].split())
        items.append({
            "name": f"{method} {value}",
            "request": {
                "method": method,
                "url": "{{base_url}}" + value,
            },
        })

    collection = {
        "info": {
            "name": "APK API endpoints",
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "item": items,
    }
    with open(output_file, "w", encoding="utf-8") as handle:
        json.dump(collection, handle, indent=2)
    print(f"Output collection JSON file created: {output_file}")


def main():
    parser = argparse.ArgumentParser(
        description="Extract API endpoints from an APK (Hermes/JS bundle, dex, and optional Retrofit smali)."
    )
    parser.add_argument("-apk", "--apk-path", help="Path to the APK file")
    parser.add_argument("-s", "--smali-folder", help="Path to an already decoded smali folder")
    parser.add_argument("-o", "--output-file", required=True, help="Path to the output file")
    parser.add_argument(
        "-f",
        "--output-format",
        choices=["txt", "postman"],
        default="txt",
        help="Output format (txt or postman)",
    )
    parser.add_argument(
        "--decompile",
        action="store_true",
        help="Also decode the APK with apktool and scan smali for Retrofit annotations",
    )
    args = parser.parse_args()

    app_urls = []
    endpoints = []
    library_urls = []
    http_annotations = []
    okhttp3_variables = []

    if args.apk_path:
        if not os.path.isfile(args.apk_path):
            parser.error(f"APK not found: {args.apk_path}")
        app_urls, endpoints, library_urls = collect_from_apk(args.apk_path)
        if args.decompile:
            apk_name = os.path.splitext(os.path.basename(args.apk_path))[0]
            output_dir = os.path.join(os.getcwd(), apk_name)
            print(f"Decoding {args.apk_path} with apktool...")
            decompile_apk(args.apk_path, output_dir)
            http_annotations, okhttp3_variables = process_smali_files(output_dir)

    if args.smali_folder:
        if not os.path.isdir(args.smali_folder):
            parser.error(f"Smali folder not found: {args.smali_folder}")
        http_annotations, okhttp3_variables = process_smali_files(args.smali_folder)

    if not args.apk_path and not args.smali_folder:
        parser.error("Pass -apk or -s")

    if args.output_format == "postman":
        generate_postman_output(app_urls, endpoints, http_annotations, args.output_file)
    else:
        generate_txt_output(
            app_urls,
            endpoints,
            library_urls,
            http_annotations,
            okhttp3_variables,
            args.output_file,
        )


if __name__ == "__main__":
    main()
