// SSH shell owned by the micro-server. Credentials arrive over stdin only.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type config struct {
	HostAlgorithm string
	Host          string
	Port          int
	User          string
	Digest        string
	Password      *string
	Key           string
}
type message struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Columns int    `json:"columns,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	Error   string `json:"error,omitempty"`
}

var outputMu sync.Mutex

func emit(m message) { outputMu.Lock(); defer outputMu.Unlock(); json.NewEncoder(os.Stdout).Encode(m) }

type terminalWriter struct{}

func (terminalWriter) Write(p []byte) (int, error) {
	emit(message{Type: "data", Data: base64.StdEncoding.EncodeToString(p)})
	return len(p), nil
}
func run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 512*1024)
	if !scanner.Scan() {
		return errors.New("缺少 SSH 连接参数")
	}
	var c config
	if err := json.Unmarshal(scanner.Bytes(), &c); err != nil {
		return errors.New("SSH 连接参数无效")
	}
	if c.Host == "" || c.User == "" || c.Port < 1 || c.Port > 65535 || c.Digest == "" {
		return errors.New("SSH 连接参数无效")
	}
	var auth []ssh.AuthMethod
	if c.Password != nil {
		auth = append(auth, ssh.Password(*c.Password))
	}
	if c.Key != "" {
		key, err := ssh.ParsePrivateKey([]byte(c.Key))
		if err != nil {
			return errors.New("SSH 私钥格式不受支持")
		}
		auth = append(auth, ssh.PublicKeys(key))
	}
	expected := c.Digest
	clientConfig := &ssh.ClientConfig{User: c.User, Auth: auth, Timeout: 20 * time.Second, HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
		digest := sha256.Sum256(key.Marshal())
		if base64.StdEncoding.EncodeToString(digest[:]) != expected {
			return errors.New("SSH 主机密钥已变化，请重新验证")
		}
		return nil
	}}
	if c.HostAlgorithm != "" {
		clientConfig.HostKeyAlgorithms = []string{c.HostAlgorithm}
	}
	address := net.JoinHostPort(c.Host, fmt.Sprint(c.Port))
	conn, err := net.DialTimeout("tcp", address, 20*time.Second)
	if err != nil {
		return errors.New("无法连接 SSH 设备")
	}
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	transport, chans, requests, err := ssh.NewClientConn(conn, address, clientConfig)
	if err != nil {
		conn.Close()
		return errors.New("SSH 后台连接认证失败，请重新连接并验证密码或密钥")
	}
	conn.SetDeadline(time.Time{})
	client := ssh.NewClient(transport, chans, requests)
	defer client.Close()
	c.Password = nil
	c.Key = ""
	clientConfig.Auth = nil
	shell, err := client.NewSession()
	if err != nil {
		return err
	}
	defer shell.Close()
	input, err := shell.StdinPipe()
	if err != nil {
		return err
	}
	shell.Stdout = terminalWriter{}
	shell.Stderr = terminalWriter{}
	if err = shell.RequestPty("xterm-256color", 24, 80, ssh.TerminalModes{ssh.ECHO: 1}); err != nil {
		return err
	}
	if err = shell.Shell(); err != nil {
		return err
	}
	emit(message{Type: "ready"})
	done := make(chan error, 1)
	go func() { done <- shell.Wait() }()
	go func() {
		defer client.Close()
		for scanner.Scan() {
			var m message
			if json.Unmarshal(scanner.Bytes(), &m) != nil {
				return
			}
			switch m.Type {
			case "input":
				data, err := base64.StdEncoding.DecodeString(m.Data)
				if err != nil || len(data) > 256*1024 {
					return
				}
				if _, err = io.Copy(input, bytes.NewReader(data)); err != nil {
					return
				}
			case "resize":
				if m.Rows < 1 || m.Rows > 1000 || m.Columns < 1 || m.Columns > 1000 {
					return
				}
				if shell.WindowChange(m.Rows, m.Columns) != nil {
					return
				}
			default:
				return
			}
		}
	}()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			return err
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			response := make(chan error, 1)
			go func() { _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); response <- err }()
			select {
			case err := <-response:
				if err != nil {
					return errors.New("SSH 连接已中断")
				}
			case <-time.After(15 * time.Second):
				return errors.New("SSH 设备未响应")
			}
			conn.SetWriteDeadline(time.Time{})
		}
	}
}
func main() {
	if err := run(); err != nil {
		emit(message{Type: "error", Error: err.Error()})
		os.Exit(1)
	}
}
