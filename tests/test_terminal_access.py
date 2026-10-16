import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('access', Path(__file__).parents[1]/'content/terminal-access.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class TicketTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'HOST_TERMINAL_SECRET': 'synthetic-terminal-key-for-tests-only'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_valid_ticket_is_bound_to_origin_and_used_once(self):
        used = {}
        ticket = access.issue('admin-test', 'device.example.test', now=100)
        self.assertEqual(access.consume(ticket, 'https://device.example.test', used, now=101), 'admin-test')
        with self.assertRaises(ValueError):
            access.consume(ticket, 'https://device.example.test', used, now=102)

    def test_expiry_tampering_origin_and_missing_key_are_rejected(self):
        ticket = access.issue('admin-test', 'device.example.test', now=100)
        for token, origin, now in [(ticket, 'https://device.example.test', 146),
                                    (ticket+'0', 'https://device.example.test', 101),
                                    (ticket, 'https://other.example.test', 101),
                                    (ticket, None, 101)]:
            with self.assertRaises(ValueError):
                access.consume(token, origin, {}, now=now)
        with patch.dict(os.environ, {'HOST_TERMINAL_SECRET': ''}):
            with self.assertRaises(ValueError):
                access.issue('admin-test', 'device.example.test')
