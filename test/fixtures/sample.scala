trait Serializable {
  def toJson: String
  def fromJson(json: String): Unit
}

object Registry {
  private var entries: Map[String, Any] = Map.empty

  def register(key: String, value: Any): Unit = {
    entries = entries + (key -> value)
  }

  def lookup(key: String): Option[Any] = entries.get(key)
}

class EventBus extends Serializable {
  private var listeners: List[String => Unit] = List.empty

  def subscribe(handler: String => Unit): Unit = {
    listeners = handler :: listeners
  }

  def publish(event: String): Unit = {
    listeners.foreach(_(event))
  }

  def toJson: String = s"""{"listeners": ${listeners.length}}"""
  def fromJson(json: String): Unit = {}
}

def parseConfig(raw: String): Map[String, String] = {
  raw.split("\n")
    .map(_.split("=", 2))
    .collect { case Array(k, v) => k.trim -> v.trim }
    .toMap
}
