from mcpsignals.sinks.base import Sink
from mcpsignals.sinks.console import ConsoleSink

__all__ = ["Sink", "ConsoleSink"]

try:
    from mcpsignals.sinks.postgres import PostgresSink  # noqa: F401

    __all__.append("PostgresSink")
except ImportError:
    pass

try:
    from mcpsignals.sinks.bigquery import BigQuerySink  # noqa: F401

    __all__.append("BigQuerySink")
except ImportError:
    pass

try:
    from mcpsignals.sinks.otlp import OtlpSink  # noqa: F401

    __all__.append("OtlpSink")
except ImportError:
    pass
