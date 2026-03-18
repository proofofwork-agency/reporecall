package main

import "fmt"

// Config holds application configuration.
type Config struct {
	Host string
	Port int
	Debug bool
}

type Logger interface {
	Log(message string)
	Error(err error)
}

func NewConfig(host string, port int) *Config {
	return &Config{
		Host: host,
		Port: port,
		Debug: false,
	}
}

func (c *Config) Address() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func main() {
	cfg := NewConfig("localhost", 8080)
	fmt.Println(cfg.Address())
}
