-- P04/P06/P07 C03/C06 A01/A06/A07/A10 E04/E05/E06/E10 subsets.
ALTER TABLE cw_method_actions DROP CONSTRAINT cw_method_actions_operation_check;
ALTER TABLE cw_method_actions ADD CONSTRAINT cw_method_actions_operation_check
 CHECK(operation IN ('create','revise','verify','publish','withdraw','transfer'));
