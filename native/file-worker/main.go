// Bounded file operations over a private stdio channel; no network listener.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const chunkSize = 65536
const maxFile = int64(2 << 30)

type request struct {
	ID          int    `json:"id"`
	Action      string `json:"action"`
	Path        string `json:"path"`
	Destination string `json:"destination"`
	Data        string `json:"data"`
	Size        int64  `json:"size"`
	Overwrite   bool   `json:"overwrite"`
}
type entry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Type     string `json:"type"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}
type worker struct {
	upload            *os.File
	temporary, target string
	expected, written int64
	overwrite         bool
	download          *os.File
}

func path(value string) (string, error) {
	if value == "" || strings.ContainsRune(value, 0) || !filepath.IsAbs(value) {
		return "", errors.New("需要有效的绝对路径")
	}
	return filepath.Clean(value), nil
}
func (w *worker) cancel() {
	if w.upload != nil {
		w.upload.Close()
		w.upload = nil
	}
	if w.temporary != "" {
		os.Remove(w.temporary)
		w.temporary = ""
	}
	if w.download != nil {
		w.download.Close()
		w.download = nil
	}
}
func fileEntry(p string, info os.FileInfo) entry {
	kind := "file"
	if info.IsDir() {
		kind = "dir"
	} else if !info.Mode().IsRegular() {
		kind = "special"
	}
	return entry{info.Name(), p, kind, info.Size(), info.ModTime().Unix()}
}
func (w *worker) execute(r request) (map[string]any, error) {
	out := map[string]any{}
	switch r.Action {
	case "list":
		p, e := path(r.Path)
		if e != nil {
			return nil, e
		}
		dir, e := os.Open(p)
		if e != nil {
			return nil, e
		}
		defer dir.Close()
		infos, e := dir.Readdir(5001)
		if e != nil && e != io.EOF {
			return nil, e
		}
		truncated := len(infos) > 5000
		if truncated {
			infos = infos[:5000]
		}
		items := []entry{}
		for _, info := range infos {
			item := fileEntry(filepath.Join(p, info.Name()), info)
			if info.Mode()&os.ModeSymlink != 0 {
				if target, e := os.Stat(item.Path); e == nil {
					item = fileEntry(item.Path, target)
					item.Name = info.Name()
				}
			}
			items = append(items, item)
		}
		sort.Slice(items, func(i, j int) bool {
			if (items[i].Type == "dir") != (items[j].Type == "dir") {
				return items[i].Type == "dir"
			}
			return items[i].Name < items[j].Name
		})
		out["entries"] = items
		out["path"] = p
		out["parent"] = filepath.Dir(p)
		out["truncated"] = truncated
	case "mkdir":
		p, e := path(r.Path)
		if e != nil {
			return nil, e
		}
		return out, os.Mkdir(p, 0755)
	case "remove":
		p, e := path(r.Path)
		if e != nil {
			return nil, e
		}
		if p == "/" {
			return nil, errors.New("不能删除根目录")
		}
		return out, os.Remove(p)
	case "rename":
		p, e := path(r.Path)
		if e != nil {
			return nil, e
		}
		dest, e := path(r.Destination)
		if e != nil {
			return nil, e
		}
		if p == "/" {
			return nil, errors.New("不能移动根目录")
		}
		if _, e := os.Lstat(dest); !os.IsNotExist(e) {
			return nil, errors.New("目标已存在")
		}
		return out, os.Rename(p, dest)
	case "upload-start":
		w.cancel()
		p, e := path(r.Path)
		if e != nil {
			return nil, e
		}
		if r.Size < 0 || r.Size > maxFile {
			return nil, errors.New("单文件不能超过 2 GiB")
		}
		if st, e := os.Lstat(p); e == nil {
			if !r.Overwrite {
				return nil, errors.New("文件已存在，请确认覆盖")
			}
			if !st.Mode().IsRegular() {
				return nil, errors.New("只能覆盖普通文件")
			}
		} else if !os.IsNotExist(e) {
			return nil, e
		}
		f, e := os.CreateTemp(filepath.Dir(p), ".tabby-upload-")
		if e != nil {
			return nil, e
		}
		w.upload = f
		w.temporary = f.Name()
		w.target = p
		w.expected = r.Size
		w.written = 0
		w.overwrite = r.Overwrite
	case "upload-chunk":
		if w.upload == nil {
			return nil, errors.New("上传尚未开始")
		}
		b, e := base64.StdEncoding.DecodeString(r.Data)
		if e != nil || len(b) > chunkSize || w.written+int64(len(b)) > w.expected {
			return nil, errors.New("上传数据大小无效")
		}
		n, e := w.upload.Write(b)
		w.written += int64(n)
		if e != nil {
			return nil, e
		}
		out["written"] = w.written
	case "upload-finish":
		if w.upload == nil || w.written != w.expected {
			return nil, errors.New("上传尚未完成")
		}
		if e := w.upload.Sync(); e != nil {
			return nil, e
		}
		if e := w.upload.Close(); e != nil {
			return nil, e
		}
		w.upload = nil
		if w.overwrite {
			if st, e := os.Lstat(w.target); e == nil && !st.Mode().IsRegular() {
				return nil, errors.New("只能覆盖普通文件")
			}
			if e := os.Rename(w.temporary, w.target); e != nil {
				return nil, e
			}
		} else {
			if e := os.Link(w.temporary, w.target); e != nil {
				return nil, e
			}
			os.Remove(w.temporary)
		}
		out["path"] = w.target
		w.temporary = ""
	case "download-start":
		w.cancel()
		p, e := path(r.Path)
		if e != nil {
			return nil, e
		}
		f, e := os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if e != nil {
			return nil, e
		}
		st, e := f.Stat()
		if e != nil || !st.Mode().IsRegular() || st.Size() > maxFile {
			f.Close()
			return nil, errors.New("请选择不超过 2 GiB 的普通文件")
		}
		w.download = f
		out["name"] = filepath.Base(p)
		out["size"] = st.Size()
	case "download-chunk":
		if w.download == nil {
			return nil, errors.New("下载尚未开始")
		}
		b := make([]byte, chunkSize)
		n, e := w.download.Read(b)
		if e != nil && e != io.EOF {
			return nil, e
		}
		out["data"] = base64.StdEncoding.EncodeToString(b[:n])
		out["eof"] = e == io.EOF
		if e == io.EOF {
			w.download.Close()
			w.download = nil
		}
	case "cancel":
		w.cancel()
	default:
		return nil, errors.New("不支持的文件操作")
	}
	return out, nil
}
func serve(input io.Reader, output io.Writer) error {
	w := &worker{}
	defer w.cancel()
	encoder := json.NewEncoder(output)
	cwd, _ := os.Getwd()
	if e := encoder.Encode(map[string]any{"type": "files-ready", "path": cwd, "capabilities": map[string]bool{"upload": true, "write": true}}); e != nil {
		return e
	}
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), 256*1024)
	for scan.Scan() {
		var r request
		if e := json.Unmarshal(scan.Bytes(), &r); e != nil {
			return errors.New("invalid file request")
		}
		out, e := w.execute(r)
		if e != nil {
			w.cancel()
			out = map[string]any{"error": e.Error()}
		}
		out["id"] = r.ID
		if e := encoder.Encode(out); e != nil {
			return e
		}
	}
	return scan.Err()
}
func main() {
	if len(os.Args) == 3 && os.Args[1] == "--root" {
		if e := syscall.Chroot(os.Args[2]); e != nil {
			fmt.Fprintln(os.Stderr, "host filesystem unavailable")
			os.Exit(1)
		}
		os.Chdir("/")
	} else if len(os.Args) == 2 && os.Args[1] == "--ephemeral" {
		os.Remove(os.Args[0])
	} else if len(os.Args) != 1 {
		os.Exit(2)
	}
	if e := serve(os.Stdin, os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, "file channel closed")
		os.Exit(1)
	}
}
