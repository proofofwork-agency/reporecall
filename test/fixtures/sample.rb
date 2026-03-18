# Logging utility module
module Logging
  def log(message)
    puts "[#{Time.now}] #{message}"
  end
end

class HttpClient
  include Logging

  def initialize(base_url)
    @base_url = base_url
    @timeout = 30
  end

  def get(path)
    log("GET #{@base_url}#{path}")
    fetch(:get, path)
  end

  def post(path, body)
    log("POST #{@base_url}#{path}")
    fetch(:post, path, body)
  end

  def self.default_client
    new("https://api.example.com")
  end

  private

  def fetch(method, path, body = nil)
    { method: method, url: "#{@base_url}#{path}", body: body }
  end
end
