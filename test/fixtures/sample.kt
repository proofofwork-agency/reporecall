interface Validator<T> {
    fun validate(input: T): Boolean
    fun errorMessage(): String
}

object AppConfig {
    val version = "1.0.0"
    val maxRetries = 3

    fun isDebug(): Boolean = System.getenv("DEBUG") == "true"
}

class EmailValidator : Validator<String> {
    private val pattern = Regex("^[\\w.-]+@[\\w.-]+\\.\\w+$")

    override fun validate(input: String): Boolean {
        return pattern.matches(input)
    }

    override fun errorMessage(): String {
        return "Invalid email format"
    }
}

fun <T> retry(times: Int, block: () -> T): T {
    var lastException: Exception? = null
    repeat(times) {
        try {
            return block()
        } catch (e: Exception) {
            lastException = e
        }
    }
    throw lastException!!
}
